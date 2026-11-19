import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { WebFunction, WebFunctionEndpoint, WebFunctionAuthType } from '@pulumi/awsx-next';
import { web } from '../shared/web';

const config = new pulumi.Config();
const releaseTag = config.require('releaseTag');
// An empty baseline bootstraps production. Subsequent stages explicitly select the stable ID
// and the amount of traffic that should go to the revision produced by this release.
const stableRevisionId = config.require('stableRevisionId').replace(/^bootstrap$/, '');
const candidatePercent = config.requireNumber('candidatePercent');
if (![0, 10, 100].includes(candidatePercent) || (!stableRevisionId && candidatePercent !== 100)) {
  throw new Error(
    'candidatePercent must be 0, 10, or 100, and a stable revision is required below 100%.',
  );
}

const app = new WebFunction('dashboard', {
  functionName: web.functionName,
  code: new pulumi.asset.FileArchive(path.join(__dirname, 'app')),
  // Use the pinned source commit so a new demo commit publishes a new revision without
  // requiring a source change to the upstream dashboard.
  environmentVariables: { DEMO_RELEASE: releaseTag },
  tags: { demo: 'awsx-delivery-web' },
});

const authType = WebFunctionAuthType.APPLICATION_MANAGED;
const revisions = app.revisionId.apply((candidate) => {
  if (candidatePercent === 100 || candidate === stableRevisionId) {
    return [{ revisionId: candidate }];
  }
  if (candidatePercent === 0) {
    return [{ revisionId: stableRevisionId }];
  }
  return [
    { revisionId: stableRevisionId, weight: 100 - candidatePercent },
    { revisionId: candidate, weight: candidatePercent },
  ];
});

const production = new WebFunctionEndpoint('production', {
  functionName: app.functionName,
  endpointName: web.productionEndpointName,
  authType,
  revisions,
});
const test = new WebFunctionEndpoint('test', {
  functionName: app.functionName,
  endpointName: 'test',
  authType,
  revisions: [{ revisionId: app.revisionId }],
});

export const candidateRevisionId = app.revisionId;
export const productionUrl = production.url;
export const testUrl = test.url;
