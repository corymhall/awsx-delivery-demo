import * as delivery from '@pulumi/delivery';
import * as privateAwsxNext from '@pulumi/awsx-next-private';
import * as pulumi from '@pulumi/pulumi';

const app = new delivery.GitHubSource('app', {
  branch: 'main',
  repository: 'corymhall/awsx-delivery-demo',
  trigger: true,
});

const pipeline = new delivery.Pipeline('demo', {
  program: {
    directory: 'pipeline',
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
      stack: `${pulumi.getOrganization()}/awsx-delivery-demo/dev`,
      source: app,
      directory: 'infra',
    },
  },
});

new privateAwsxNext.EcsDeploymentCheckpoint('checkpoint', {
  pipelineUrn: pipeline.urn,
  upstreamStageUrn: dev.urn,
  sourceUrn: app.urn,
  conditionName: 'pause-hook',
  clusterArn: stacks.outputs.apply((outputs) => String(outputs.app.ecsCluster)),
  serviceName: stacks.outputs.apply((outputs) => String(outputs.app.ecsService)),
  taskDefinitionArn: stacks.outputs.apply((outputs) => String(outputs.app.ecsTaskDefinition)),
  region: 'us-east-2',
  environment: 'awsx-delivery-demo/dev',
});
