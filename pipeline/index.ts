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
const checkpoint = new delivery.Stage('checkpoint', {
  pipeline,
  from: [dev],
  when: delivery.allOfOutput({
    rules: [
      delivery.approvalOutput(),
      delivery.manualOutput({ name: 'pause-hook', description: 'Wait for ECS test traffic' }),
    ],
  }),
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
}));

new delivery.Job('verify-deployment', {
  stage: checkpoint,
  command:
    'pulumi env run awsx-delivery-demo/dev -- bash -c \'deployment_arn=$(./find-ecs-deployment.sh) && ./wait-for-ecs-deployment.sh "$deployment_arn" 1800\'',
  directory: 'pipeline/scripts',
  source: app,
  environment: env,
});
