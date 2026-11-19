import * as delivery from '@pulumi/delivery';
import * as pulumi from '@pulumi/pulumi';
import { WebFunctionCanary } from '@pulumi/awsx-delivery';
import { web } from '../shared/web';

const source = new delivery.GitHubSource('web-source', {
  repository: web.repository,
  branch: web.branch,
  trigger: true,
});
const pipeline = new delivery.Pipeline('web-canary');

new WebFunctionCanary('dashboard', {
  pipelineUrn: pipeline.urn,
  sourceUrn: source.urn,
  target: {
    stackName: `${pulumi.getOrganization()}/${web.infraProject}/${web.stack}`,
    directory: 'infra-web',
  },
  awsEnvironment: `${pulumi.getOrganization()}/${web.awsEnvironment}`,
  verification: {
    directory: 'pipeline-web',
    command: 'node --experimental-strip-types scripts/probe.ts',
  },
});
