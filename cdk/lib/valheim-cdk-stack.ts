import * as cdk from '@aws-cdk/core';
import * as path from 'path';
import {Arn, ArnFormat, Duration, RemovalPolicy} from '@aws-cdk/core';
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import {MountPoint, Protocol} from "@aws-cdk/aws-ecs";
import * as efs from "@aws-cdk/aws-efs";
import * as iam from "@aws-cdk/aws-iam";
import * as logs from "@aws-cdk/aws-logs";
import * as r53 from "@aws-cdk/aws-route53"
import * as lambda from "@aws-cdk/aws-lambda";
import * as dotenv from 'dotenv';

dotenv.config({path: path.resolve(__dirname, '../.env') });


interface ValheimCDKStackProps extends cdk.StackProps {
  launcherLambdaRoleArn: string;
}

export class ValheimCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ValheimCDKStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "ValheimVpc", {
      maxAzs: 2,
      natGateways: 0
    })

    const fileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc,
      removalPolicy: RemovalPolicy.SNAPSHOT
    })

    const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
      fileSystem,
      path: '/valheim',
      posixUser: {
        uid: '0',
        gid: '0',
      },
      createAcl: {
        ownerGid: '0',
        ownerUid: '0',
        permissions: '0755'
      }
    });

    const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowReadWriteOnEFS',
          effect: iam.Effect.ALLOW,
          actions: [
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite',
            'elasticfilesystem:DescribeFileSystems',
          ],
          resources: [fileSystem.fileSystemArn],
          conditions: {
            StringEquals: {
              'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
            }
          }
        })
      ]
    })

    const ecsTaskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Valheim ECS Task Role',
    })

    efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

    const cluster = new ecs.Cluster(this, "ValheimCluster", {
      clusterName: 'ValheimCDKCluster',
      vpc,
      enableFargateCapacityProviders: true,
    })

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      taskRole: ecsTaskRole,
      cpu: 512,
      memoryLimitMiB: 3072,
      volumes: [
        {
          name: 'ValheimGameDataVolume',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
              iam: 'ENABLED'
            }
          }
        }
      ]
    })

    const valheimServerContainer = new ecs.ContainerDefinition(this, 'ValheimContainer', {
      containerName: 'ValheimServer',
      image: ecs.ContainerImage.fromRegistry('lloesche/valheim-server'),
      portMappings: [
        {
          containerPort: 2456,
          hostPort: 2456,
          protocol: Protocol.UDP
        },
        {
          containerPort: 2457,
          hostPort: 2457,
          protocol: Protocol.UDP
        },
        {
          containerPort: 9001,
          hostPort: 9001,
          protocol: Protocol.TCP
        },
        {
          containerPort: 22,
          hostPort: 22,
          protocol: Protocol.TCP
        }
      ],
      taskDefinition,
      logging: new ecs.AwsLogDriver({
        logRetention: logs.RetentionDays.THREE_DAYS,
        streamPrefix: 'ValheimServer'
      }),
      environment: {
        SERVER_NAME: "DimmosServer",
        WORLD_NAME: "DimmoWorld",
        SERVER_PUBLIC: "false",
        SERVER_PASS: process.env.SERVER_PASS!,
        BACKUP_IF_IDLE: "false",
        ADMINLIST_IDS: "76561197972993222 76561198024307310 76561197998682695 76561197972250772"
      }
    })

    const valheimServerConfigMountPoint: MountPoint = {
      containerPath: '/config',
      sourceVolume: 'ValheimGameDataVolume',
      readOnly: false,
    }
    const valheimServerDataMountPoint: MountPoint = {
      containerPath: '/opt/valheim',
      sourceVolume: 'ValheimGameDataVolume',
      readOnly: false,
    }

    valheimServerContainer.addMountPoints(valheimServerDataMountPoint, valheimServerConfigMountPoint)


    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Security Group for ValheimServerService'
    });

    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(2456))
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(2457))
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9001))

    const valheimServerService = new ecs.FargateService(this, 'FargateService', {
      cluster,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
          base: 1,
        }
      ],
      taskDefinition,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      serviceName: 'ValheimServerService',
      desiredCount: 0,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup]
    })

    const autoScaling = valheimServerService.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 1,
    });

    autoScaling.scaleOnMetric('ScaleDownOnCpuUsage', {
      metric: valheimServerService.metric('CPUUtilization'),
      scalingSteps: [
        {upper: 15, change: -1},
        {lower: 50, change: 0},
      ],
      cooldown: cdk.Duration.minutes(30),
      evaluationPeriods: 5,
    })

    fileSystem.connections.allowDefaultPortFrom(valheimServerService.connections);

    const hostedZoneId = r53.HostedZone.fromLookup(this, 'HostedZoneLookup', {
      domainName: process.env.HOSTED_ZONE_NAME!
    })

    const watchDoggoContainer = new ecs.ContainerDefinition(this, 'WatchDogContainer', {
      containerName: 'WatchDogContainer',
      image: ecs.ContainerImage.fromAsset(
          path.resolve(__dirname, '../../watchdog')
      ),
      essential: false,
      taskDefinition,
      environment: {
        CLUSTER: 'ValheimCDKCluster',
        SERVICE: 'ValheimServerService',
        DNSZONE: hostedZoneId.hostedZoneId,
        SERVERNAME: process.env.SERVER_NAME!,
        DISCORDWEBHOOK: process.env.DISCORD_WEBHOOK || ''
      },
      logging: new ecs.AwsLogDriver({
        logRetention: logs.RetentionDays.THREE_DAYS,
        streamPrefix: 'WatchDogContainer',
      })
    })

    const serviceControlPolicy = new iam.Policy(this, 'ServiceControlPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowAllOnServiceAndTask',
          effect: iam.Effect.ALLOW,
          actions: ['ecs:*'],
          resources: [
            valheimServerService.serviceArn,
            Arn.format(
                {
                  service: 'ecs',
                  resource: 'task',
                  resourceName: `ValheimCDKCluster/*`,
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                },
                this
            ),
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeNetworkInterfaces'],
          resources: ['*'],
        }),
      ],
    });

    serviceControlPolicy.attachToRole(ecsTaskRole);

    const iamRoute53Policy = new iam.Policy(this, 'IamRoute53Policy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowEditRecordSets',
          effect: iam.Effect.ALLOW,
          actions: [
            'route53:GetHostedZone',
            'route53:ChangeResourceRecordSets',
            'route53:ListResourceRecordSets',
          ],
          resources: [hostedZoneId.hostedZoneArn],
        }),
      ],
    });
    iamRoute53Policy.attachToRole(ecsTaskRole);

    const launcherLambdaRole = iam.Role.fromRoleArn(this,
        'LauncherLambdaRole',
        props.launcherLambdaRoleArn);

    serviceControlPolicy.attachToRole(launcherLambdaRole);


  }
}
