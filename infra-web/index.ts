import * as path from 'node:path';
import * as aws from '@pulumi/aws';
import * as ccapi from '@pulumi/aws-native';
import * as pulumi from '@pulumi/pulumi';
import { WebFunctionCanaryRouting } from '@pulumi/awsx-delivery';
import { WebFunction, WebFunctionEndpoint, WebFunctionAuthType } from '@pulumi/awsx-next';

const region = new pulumi.Config('aws').require('region') as aws.Region;
const defaultTags = {
  tags: {
    'delivery:app': pulumi.getProject(),
    'delivery:environment': pulumi.getStack(),
    owner: 'chall',
  },
};
const provider = new aws.Provider('aws', { region, defaultTags });
const ccapiProvider = new ccapi.Provider('aws-native', { region, defaultTags });

const providers = [provider, ccapiProvider];

const releaseTag = new pulumi.Config('webFunctionCanary').require('releaseTag');
const app = new WebFunction(
  'dashboard',
  {
    code: new pulumi.asset.FileArchive(path.join(__dirname, 'app')),
    // Publish a new revision for each source commit, even if the demo assets are unchanged.
    environmentVariables: { DEMO_RELEASE: releaseTag },
  },
  { providers },
);

const routing = new WebFunctionCanaryRouting('routing', {
  candidateRevisionId: app.revisionId,
});

const authType = WebFunctionAuthType.APPLICATION_MANAGED;
const test = new WebFunctionEndpoint(
  'test',
  {
    functionName: app.functionName,
    authType,
    revisions: [{ revisionId: routing.candidateRevisionId }],
  },
  { providers },
);
const production = new WebFunctionEndpoint(
  'production',
  {
    functionName: app.functionName,
    authType,
    revisions: routing.productionRevisions,
  },
  { providers },
);

export const candidateRevisionId = routing.candidateRevisionId;
export const functionArn = app.functionArn;
export const productionEndpointArn = production.endpointArn;
export const productionUrl = production.url;
export const testUrl = test.url;
