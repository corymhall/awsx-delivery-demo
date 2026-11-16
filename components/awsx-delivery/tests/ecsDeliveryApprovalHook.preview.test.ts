import * as pulumi from '@pulumi/pulumi';
import { EcsDeliveryApprovalHook } from '../src/ecsDeliveryApprovalHook';

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      return { id: args.name, state: { ...args.inputs, arn: `arn:aws:mock::123:${args.name}` } };
    },
    call(args) {
      return args.inputs;
    },
  },
  'project',
  'stack',
  true,
);

const args = {
  pipelineStack: pulumi.output('acme/pipeline/dev'),
  checkpoint: { stageName: 'checkpoint' },
  authentication: { teamOidc: { teamName: 'hooks' } },
};
const originalPipeline = process.env.DELIVERY_PIPELINE;
const originalRun = process.env.DELIVERY_RUN;
beforeEach(() => {
  delete process.env.DELIVERY_PIPELINE;
  delete process.env.DELIVERY_RUN;
});
afterEach(() => {
  if (originalPipeline === undefined) delete process.env.DELIVERY_PIPELINE;
  else process.env.DELIVERY_PIPELINE = originalPipeline;
  if (originalRun === undefined) delete process.env.DELIVERY_RUN;
  else process.env.DELIVERY_RUN = originalRun;
});

test('local preview permits the default policy but does not generate a manual bypass', async () => {
  const hook = new EcsDeliveryApprovalHook('preview', args);
  const consumer = new pulumi.ComponentResource('test:index:Consumer', 'consumer', {
    hookDetails: hook.hookDetails,
    functionArn: hook.functionArn,
  });
  await new Promise<void>((done) => {
    consumer.urn.apply(() => {
      done();
    });
  });
  const inputs = resources.find((resource) => resource.name === 'consumer')!.inputs;
  expect(pulumi.isUnknown(inputs.hookDetails)).toBe(true);
  expect(inputs.functionArn).toBe('arn:aws:mock::123:preview');
});

test('preview does not turn partial Delivery identity into a manual preview', () => {
  process.env.DELIVERY_PIPELINE = 'acme/pipeline/dev';
  expect(() => new EcsDeliveryApprovalHook('partial-preview', args)).toThrow('DELIVERY_RUN');
});
