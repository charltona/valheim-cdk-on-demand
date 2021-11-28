import * as cdk from '@aws-cdk/core';
import * as lambda from "@aws-cdk/aws-lambda-python"
import {Runtime} from "@aws-cdk/aws-lambda";
import * as logs from "@aws-cdk/aws-logs"
import * as path from 'path';
import * as apigw from '@aws-cdk/aws-apigatewayv2';
import * as lambdaInt from "@aws-cdk/aws-apigatewayv2-integrations";


export class LauncherStack extends cdk.Stack {
  public readonly launcherLambdaRoleArn: string;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const launcherLambda = new lambda.PythonFunction(this, 'LauncherLambda', {
      entry: path.resolve(__dirname, '../../lambda'),
      index: 'startup.py',
      runtime: Runtime.PYTHON_3_8,
      handler: 'lambda_handler',
      environment: {
        // @TODO Make configurable.
      },
      logRetention: logs.RetentionDays.THREE_DAYS
    })

    this.launcherLambdaRoleArn = launcherLambda.role!.roleArn;

    const lambdaIntegration = new lambdaInt.LambdaProxyIntegration({
      handler: launcherLambda
    })

    const httpApi = new apigw.HttpApi(this, 'LauncherHttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.POST]
      },
      apiName: 'LauncherApi',
      createDefaultStage: true,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [
          apigw.HttpMethod.POST,
      ],
      integration: lambdaIntegration
    })

    new cdk.CfnOutput(this, 'LauncherAPI', {value: httpApi.url!, exportName: 'LauncherAPIEndpoint'})
  }


}