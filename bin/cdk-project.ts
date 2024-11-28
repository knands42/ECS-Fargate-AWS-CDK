#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MainStack } from '../lib/main-stack';

const { CDK_DEFAULT_REGION, CDK_DEFAULT_ACCOUNT } = process.env;

const apiSubDomainName = 'api';
const domainName = process.env.DOMAIN || 'kadxdev.com';
const hostedZoneId = process.env.HOSTED_ZONE_ID || 'Z06373351EVU62QS34UXS';

const envs = { region: CDK_DEFAULT_REGION, account: CDK_DEFAULT_ACCOUNT };

const app = new cdk.App();
new MainStack(app, 'all-in', { 
    env: envs, 
    natGateways: 2, 
    domainName, 
    hostedZoneId, 
    subDomainName: apiSubDomainName 
});