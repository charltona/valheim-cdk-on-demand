#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { SatisfactoryCdkStack } from '../lib/satisfactory-cdk-stack';
import {LauncherStack} from "../lib/launcher-stack";

const app = new cdk.App();
const {launcherLambdaRoleArn} = new LauncherStack(app, 'LauncherStack', {
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
})
new SatisfactoryCdkStack(app, 'SatisfactoryCdkStack', {
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
   launcherLambdaRoleArn,
});
