import * as cdk from '@aws-cdk/core';
import * as lambda from "@aws-cdk/aws-lambda"
import * as logs from "@aws-cdk/aws-logs"
import * as path from 'path';



export class LauncherStack extends cdk.Stack {
  public readonly launcherLambdaRoleArn: string;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const launcherLambda = new lambda.Function(this, 'LauncherLambda', {
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda')),
      handler: 'startup.lambda_handler',
      runtime: lambda.Runtime.PYTHON_3_8,
      environment: {
        // @TODO Make configurable.
      },
      logRetention: logs.RetentionDays.THREE_DAYS
    })

    this.launcherLambdaRoleArn = launcherLambda.role!.roleArn;
  }


}