import * as delivery from '@pulumi/delivery';
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

const env = stacks.outputs.apply((outputs) => ({
  AWS_REGION: 'us-east-2',
  ECS_CLUSTER: String(outputs.app.ecsCluster),
  ECS_SERVICE: String(outputs.app.ecsService),
  ECS_TASK_DEFINITION: String(outputs.app.ecsTaskDefinition),
  ECS_GATE_STAGE: 'checkpoint',
}));

const discovery = new delivery.Job('discover-deployment', {
  stage: dev,
  command: 'pulumi env run awsx-delivery-demo/dev -- bash ./discover-ecs-deployment.sh',
  directory: 'pipeline/scripts',
  source: app,
  environment: env,
});

const deploymentArn = discovery.outputs.apply((outputs) => {
  if (outputs.result === 'no-deployment' && outputs.deploymentArn === '') return '';
  if (outputs.result === 'deployment' && outputs.deploymentArn?.startsWith('arn:')) {
    return outputs.deploymentArn;
  }
  throw new Error('Deployment discovery returned an invalid result');
});

const approval = delivery.allOfOutput({
  rules: [
    delivery.approvalOutput(),
    delivery.manualOutput({ name: 'pause-hook', description: 'Wait for ECS test traffic' }),
  ],
});

// Keep the stage declared during preview. Its gate is unknown until discovery finishes.
const checkpoint = new delivery.Stage('checkpoint', {
  pipeline,
  from: [dev],
  when: deploymentArn.apply((arn) => (arn ? approval : undefined)),
});

// Defer the stage reference until discovery resolves. This Job is absent from
// previews while discovery is unknown; checkpoint itself remains declared.
deploymentArn.apply((arn) => {
  new delivery.Job('verify-deployment', {
    stage: checkpoint,
    command:
      'if [ -n "$ECS_DEPLOYMENT_ARN" ]; then pulumi env run awsx-delivery-demo/dev -- bash ./wait-for-ecs-deployment.sh "$ECS_DEPLOYMENT_ARN" 1800; else echo "No ECS deployment for this run; nothing to approve or wait for."; fi',
    directory: 'pipeline/scripts',
    source: app,
    environment: { AWS_REGION: 'us-east-2', ECS_DEPLOYMENT_ARN: arn },
  });
});
