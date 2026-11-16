import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { EcsDeploymentCheckpoint } from '../src/ecsDeploymentCheckpoint';

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      return { id: args.name, state: { ...args.inputs, outputs: pulumi.unknown } };
    },
    call(args) {
      return args.inputs;
    },
  },
  'project',
  'stack',
  true,
);

test('unknown discovery creates neither checkpoint resources nor a no-op continuation', async () => {
  const source = new delivery.GitHubSource('source', { repository: 'acme/app', branch: 'main' });
  const pipeline = new delivery.Pipeline('app', { program: { directory: '.', source } });
  const upstream = new delivery.Stage('infra', { pipeline });
  const component = new EcsDeploymentCheckpoint('checkpoint', {
    pipelineUrn: pipeline.urn,
    upstreamStageUrn: upstream.urn,
    sourceUrn: source.urn,
    serviceArn: pulumi
      .output(pulumi.unknown)
      .apply(() => 'arn:aws:ecs:us-east-2:123456789012:service/cluster/app'),
    taskDefinitionArn: 'task:1',
    environment: 'app/dev',
  });
  const consumer = new pulumi.ComponentResource('test:index:Consumer', 'consumer', {
    continuationStageUrn: component.continuationStageUrn,
    stageUrn: component.stageUrn,
    verificationJobUrn: component.verificationJobUrn,
  });
  await new Promise<void>((done) => {
    consumer.urn.apply(() => {
      done();
    });
  });
  const inputs = resources.find((resource) => resource.name === 'consumer')!.inputs;
  expect(pulumi.isUnknown(inputs.continuationStageUrn)).toBe(true);
  expect(pulumi.isUnknown(inputs.stageUrn)).toBe(true);
  expect(pulumi.isUnknown(inputs.verificationJobUrn)).toBe(true);
  expect(
    resources.find(
      (resource) => resource.type === 'delivery:index:Stage' && resource.name === 'checkpoint',
    ),
  ).toBeUndefined();
  expect(resources.find((resource) => resource.name === 'checkpoint-verify')).toBeUndefined();
  const discovery = resources.find((resource) => resource.name === 'checkpoint-discover')!;
  for (const key of ['AWS_REGION', 'ECS_CLUSTER', 'ECS_SERVICE']) {
    expect(pulumi.isUnknown(discovery.inputs.environment[key])).toBe(true);
  }
});
