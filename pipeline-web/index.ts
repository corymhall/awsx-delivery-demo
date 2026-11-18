import * as delivery from '@pulumi/delivery';
import * as pulumi from '@pulumi/pulumi';
import { web } from '../shared/web';

const source = new delivery.GitHubSource('web-source', {
  repository: web.repository,
  branch: web.branch,
  trigger: true,
});
const pipeline = new delivery.Pipeline('web-canary');
const organization = pulumi.getOrganization();
const stack = `${organization}/${web.infraProject}/${web.stack}`;

const snapshot = new delivery.Stage('snapshot', { pipeline });
const baseline = new delivery.Job('read-production', {
  stage: snapshot,
  source,
  directory: 'pipeline-web',
  preRunCommands: ['npm ci'],
  command: `pulumi env run ${organization}/${web.awsEnvironment} -- node --experimental-strip-types scripts/snapshot.ts`,
});
const stable = baseline.outputs.apply((outputs) => String(outputs.stableRevisionId ?? ''));
const release = baseline.outputs.apply((outputs) => String(outputs.releaseTag));

function deploy(name: string, stage: delivery.Stage, percent: number): delivery.Stacks {
  return new delivery.Stacks(name, {
    stage,
    stacks: {
      web: {
        stack,
        source,
        directory: 'infra-web',
        config: {
          'awsx-delivery-demo-infra-web:releaseTag': release,
          'awsx-delivery-demo-infra-web:stableRevisionId': stable.apply((id) => id || 'bootstrap'),
          'awsx-delivery-demo-infra-web:candidatePercent': stable.apply((id) =>
            String(id ? percent : 100),
          ),
        },
      },
    },
  });
}

const publish = new delivery.Stage('publish', { pipeline, from: [snapshot] });
const published = deploy('publish', publish, 0);

const verify = new delivery.Stage('verify', { pipeline, from: [publish] });
new delivery.Job('smoke-test', {
  stage: verify,
  source,
  directory: 'pipeline-web',
  command: 'node --experimental-strip-types scripts/probe.ts',
  environment: { CANDIDATE_URL: published.outputs.apply((outputs) => String(outputs.web.testUrl)) },
});

const canary = new delivery.Stage('canary', { pipeline, from: [verify] });
const split = deploy('canary', canary, 10);
const observe = new delivery.Stage('observe', { pipeline, from: [canary] });
new delivery.Job('observe-five-minutes', {
  stage: observe,
  source,
  directory: 'pipeline-web',
  command: 'node --experimental-strip-types scripts/probe.ts',
  timeout: '7m',
  environment: {
    CANDIDATE_URL: split.outputs.apply((outputs) => String(outputs.web.testUrl)),
    PRODUCTION_URL: split.outputs.apply((outputs) => String(outputs.web.productionUrl)),
    CANDIDATE_REVISION: split.outputs.apply((outputs) => String(outputs.web.candidateRevisionId)),
    STABLE_REVISION: stable,
  },
});

const promote = new delivery.Stage('promote', { pipeline, from: [observe] });
deploy('promote', promote, 100);
