#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ValheimCdkStack } from '../lib/valheim-cdk-stack';
import {LauncherStack} from "../lib/launcher-stack";

const app = new cdk.App();
const {launcherLambdaRoleArn} = new LauncherStack(app, 'ValheimLauncherStack', {
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
})
new ValheimCdkStack(app, 'ValheimCdkStack', {
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
   launcherLambdaRoleArn,
});
