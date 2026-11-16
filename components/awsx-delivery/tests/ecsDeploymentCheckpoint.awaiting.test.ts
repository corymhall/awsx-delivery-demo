import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { serializeProperties, unknownValue } from '@pulumi/pulumi/runtime/rpc';
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
  false,
);

test('an awaiting discovery during an update preserves unknown outputs without creating a checkpoint or bypass', async () => {
  const source = new delivery.GitHubSource('source', { repository: 'acme/app', branch: 'main' });
  const pipeline = new delivery.Pipeline('app', { program: { directory: '.', source } });
  const upstream = new delivery.Stage('infra', { pipeline });
  const component = new EcsDeploymentCheckpoint('checkpoint', {
    pipelineUrn: pipeline.urn,
    upstreamStageUrn: upstream.urn,
    sourceUrn: source.urn,
    serviceArn: pulumi.output('arn:aws:ecs:us-east-2:123456789012:service/cluster/app'),
    taskDefinitionArn: 'task:1',
    environment: 'app/dev',
  });
  // Inspect the wire values directly. The mock monitor's own input deserializer discards
  // unknown values during updates, so inspecting MockResourceArgs would mask this regression.
  const outputs = await serializeProperties('awaiting checkpoint', {
    deploymentArn: component.deploymentArn,
    continuationStageUrn: component.continuationStageUrn,
    stageUrn: component.stageUrn,
    verificationJobUrn: component.verificationJobUrn,
  });
  expect(outputs).toEqual({
    deploymentArn: unknownValue,
    continuationStageUrn: unknownValue,
    stageUrn: unknownValue,
    verificationJobUrn: unknownValue,
  });
  expect(
    resources.find(
      (resource) => resource.type === 'delivery:index:Stage' && resource.name === 'checkpoint',
    ),
  ).toBeUndefined();
  expect(resources.find((resource) => resource.name === 'checkpoint-verify')).toBeUndefined();
  expect(resources.find((resource) => resource.name === 'checkpoint-discover')).toBeDefined();
});
