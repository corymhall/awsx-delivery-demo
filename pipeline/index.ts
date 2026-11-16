import * as delivery from '@pulumi/delivery';
import * as privateAwsxNext from '@pulumi/awsx-next-private';
import * as pulumi from '@pulumi/pulumi';
import { checkpointConfig } from '../shared/checkpoint';
import { deployment } from '../shared/deployment';

type AppOutputs = pulumi.Unwrap<typeof import('../infra/index')>;
if (checkpointConfig.completion !== privateAwsxNext.EcsCheckpointCompletion.AUTOMATED_TEST) {
  throw new Error('This pipeline requires an automated test checkpoint');
}

const app = new delivery.GitHubSource('app', {
  branch: deployment.pipeline.branch,
  repository: deployment.pipeline.repository,
  trigger: true,
});

const pipeline = new delivery.Pipeline('demo', {
  program: {
    directory: deployment.pipeline.directory,
    source: app,
  },
});

const dev = new delivery.Stage('dev', {
  pipeline,
});
const stacks = new delivery.Stacks('dev', {
  stage: dev,
  stacks: {
    app: {
      stack: `${pulumi.getOrganization()}/${deployment.app.project}/${deployment.app.stack}`,
      source: app,
      directory: deployment.app.directory,
      environment: {
        PULUMI_OPTION_REFRESH: 'true',
        PULUMI_RUN_PROGRAM: 'true',
      },
    },
  },
});

const appOutputs = stacks.outputs.app as pulumi.Output<AppOutputs>;

new privateAwsxNext.EcsDeploymentCheckpoint(checkpointConfig.stageName, {
  pipelineUrn: pipeline.urn,
  upstreamStageUrn: dev.urn,
  sourceUrn: app.urn,
  serviceArn: appOutputs.ecsServiceArn,
  taskDefinitionArn: appOutputs.ecsTaskDefinition,
  environment: deployment.app.environment,
  automatedTest: {
    command: `node --test ${deployment.app.directory}/test/integration.test.ts`,
    environment: {
      TEST_URL: appOutputs.testUrl,
      TEST_HEADER_NAME: checkpointConfig.testHeaderName,
      TEST_HEADER_VALUE: checkpointConfig.testHeaderValue,
    },
  },
});
