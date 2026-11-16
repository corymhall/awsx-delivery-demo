import * as pulumi from '@pulumi/pulumi';
import {
  EcsDeliveryApprovalHook,
  ManualUpdateBehavior,
  EcsCheckpointCompletion,
} from '../src/ecsDeliveryApprovalHook';

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource(args) {
    resources.push(args);
    return { id: args.name, state: { ...args.inputs, arn: `arn:aws:mock::123:${args.name}` } };
  },
  call(args) {
    return args.inputs;
  },
});

const args = {
  pipelineStack: pulumi.output('acme/pipeline/dev'),
  checkpoint: { stageName: 'checkpoint' },
  authentication: { teamOidc: { teamName: 'hooks' } },
};
const originalPipeline = process.env.DELIVERY_PIPELINE;
const originalRun = process.env.DELIVERY_RUN;
afterEach(() => {
  if (originalPipeline === undefined) delete process.env.DELIVERY_PIPELINE;
  else process.env.DELIVERY_PIPELINE = originalPipeline;
  if (originalRun === undefined) delete process.env.DELIVERY_RUN;
  else process.env.DELIVERY_RUN = originalRun;
});

/**
 * Resolve a Pulumi output for assertions.
 *
 * @param value Output to await.
 * @returns The resolved value.
 */
function resolve<T>(value: pulumi.Output<T>): Promise<T> {
  return new Promise((done) => {
    value.apply((result) => {
      done(result);
    });
  });
}

test('partial Delivery identity cannot turn into a manual bypass', () => {
  process.env.DELIVERY_PIPELINE = 'acme/pipeline/dev';
  delete process.env.DELIVERY_RUN;
  expect(
    () =>
      new EcsDeliveryApprovalHook('partial', {
        ...args,
        manualUpdates: ManualUpdateBehavior.BYPASS,
      }),
  ).toThrow('DELIVERY_RUN');
});

test('manual bypass is an explicit security choice', async () => {
  delete process.env.DELIVERY_PIPELINE;
  delete process.env.DELIVERY_RUN;
  expect(() => new EcsDeliveryApprovalHook('reject', args)).toThrow(
    'Run this update through Delivery',
  );
  const hook = new EcsDeliveryApprovalHook('manual', {
    ...args,
    manualUpdates: ManualUpdateBehavior.BYPASS,
  });
  expect(await resolve(hook.hookDetails)).toEqual({ mode: 'manual' });
});

test('automated completion configures the hook to wait for the test stage', async () => {
  process.env.DELIVERY_PIPELINE = 'acme/pipeline/dev';
  process.env.DELIVERY_RUN = '42';
  const hook = new EcsDeliveryApprovalHook('automated-hook', {
    ...args,
    checkpoint: {
      ...args.checkpoint,
      conditionName: 'custom-arrival',
      completion: EcsCheckpointCompletion.AUTOMATED_TEST,
    },
  });
  expect(await resolve(hook.hookDetails)).toMatchObject({
    call: {
      waitForApproval: true,
      waitForStage: true,
      request: { condition: 'custom-arrival' },
    },
  });
});

test('supplied roles receive the hook policy without creating a role', async () => {
  process.env.DELIVERY_PIPELINE = 'acme/pipeline/dev';
  process.env.DELIVERY_RUN = '42';
  const role = 'arn:aws:iam::123456789012:role/preauthorized';
  const hook = new EcsDeliveryApprovalHook('existing-role', { ...args, executionRoleArn: role });
  expect(await resolve(hook.executionRoleArn)).toBe(role);
  expect(await resolve(hook.hookDetails)).toMatchObject({
    mode: 'delivery',
    call: {
      waitForApproval: true,
      parameters: { organization: 'acme', project: 'pipeline', stack: 'dev', stage: 'checkpoint' },
      request: { runNumber: '42', condition: 'ecs-arrival' },
    },
  });
  await resolve(hook.functionArn);
  expect(
    resources.find((r) => r.name === 'existing-role' && r.type === 'aws:lambda/function:Function')!
      .inputs.environment.variables.PULUMI_ORGANIZATION,
  ).toBe('acme');
  expect(
    resources.filter((r) => r.name.startsWith('existing-role') && r.type === 'aws:iam/role:Role'),
  ).toEqual([]);
  expect(
    resources.find(
      (r) => r.name === 'existing-role-execution' && r.type === 'aws:iam/rolePolicy:RolePolicy',
    )?.inputs.role,
  ).toBe('preauthorized');
  expect(
    resources.find((r) => r.name === 'existing-role' && r.type === 'aws:lambda/function:Function')
      ?.inputs.role,
  ).toBe(role);
});
