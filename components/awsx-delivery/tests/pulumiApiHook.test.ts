import * as pulumi from '@pulumi/pulumi';
import { PulumiApiHook } from '../src/pulumiApiHook';

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource(args) {
    resources.push(args);
    return {
      id: `${args.name}-id`,
      state: {
        ...args.inputs,
        name: args.inputs.name ?? args.name,
        arn: `arn:aws:mock::123:${args.name}`,
      },
    };
  },
  call(args) {
    return args.inputs;
  },
});

/**
 * Wait for a Pulumi output so its child resources have registered.
 *
 * @param value Output to resolve.
 * @returns The resolved output value.
 */
function resolve<T>(value: pulumi.Output<T>): Promise<T> {
  return new Promise((done) =>
    value.apply((result) => {
      done(result);
    }),
  );
}

test('creates a scoped execution role, packaged function, and configured logs', async () => {
  const hook = new PulumiApiHook('managed', {
    organization: pulumi.output('acme'),
    authentication: { teamOidc: { teamName: pulumi.output('delivery') } },
    apiUrl: 'https://api.example.com',
    timeoutSeconds: 90,
    memorySizeMiB: 512,
  });
  await resolve(hook.functionArn);
  const fn = resources.find(
    (r) => r.type === 'aws:lambda/function:Function' && r.name === 'managed',
  )!;
  expect(fn.inputs).toMatchObject({
    runtime: 'nodejs24.x',
    handler: 'index.handler',
    timeout: 90,
    memorySize: 512,
    role: 'arn:aws:mock::123:managed-execution',
    loggingConfig: { logFormat: 'JSON', logGroup: 'managed-logs' },
    environment: {
      variables: {
        PULUMI_ORGANIZATION: 'acme',
        PULUMI_TEAM: 'delivery',
        PULUMI_API_URL: 'https://api.example.com',
      },
    },
  });
  const assets = await fn.inputs.code.assets;
  expect(await assets['index.js'].path).toMatch(/functions\/pulumi-api-hook\/dist\/index.js$/);
  const policy = resources.find(
    (r) => r.type === 'aws:iam/rolePolicy:RolePolicy' && r.name === 'managed-execution',
  )!;
  expect(JSON.parse(policy.inputs.policy).Statement).toEqual([
    {
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: 'arn:aws:mock::123:managed-logs:*',
    },
    {
      Effect: 'Allow',
      Action: 'sts:GetWebIdentityToken',
      Resource: '*',
      Condition: {
        'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': ['urn:pulumi:org:acme'] },
        NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
      },
    },
  ]);
});

test('attaches scoped permissions to a supplied role with a path', async () => {
  const arn = 'arn:aws-us-gov:iam::123456789012:role/platform/hooks/existing';
  const hook = new PulumiApiHook('supplied', {
    organization: 'acme',
    authentication: { teamOidc: { teamName: 'delivery' } },
    executionRoleArn: pulumi.output(arn),
  });
  expect(await resolve(hook.executionRoleArn)).toBe(arn);
  await resolve(hook.functionArn);
  const policy = resources.find(
    (r) => r.type === 'aws:iam/rolePolicy:RolePolicy' && r.name === 'supplied-execution',
  )!;
  expect(policy.inputs.role).toBe('existing');
  expect(JSON.parse(policy.inputs.policy).Statement).toEqual([
    {
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: 'arn:aws:mock::123:supplied-logs:*',
    },
    {
      Effect: 'Allow',
      Action: 'sts:GetWebIdentityToken',
      Resource: '*',
      Condition: {
        'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': ['urn:pulumi:org:acme'] },
        NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
      },
    },
  ]);
  expect(
    resources.some((r) => r.type === 'aws:iam/role:Role' && r.name === 'supplied-execution'),
  ).toBe(false);
});

test('creates a role with the default function settings', async () => {
  const hook = new PulumiApiHook('defaults', {
    organization: 'acme',
    authentication: { teamOidc: { teamName: 'delivery' } },
  });
  expect(await resolve(hook.executionRoleArn)).toBe('arn:aws:mock::123:defaults-execution');
  await resolve(hook.functionArn);
  const fn = resources.find(
    (r) => r.type === 'aws:lambda/function:Function' && r.name === 'defaults',
  )!;
  expect(fn.inputs).toMatchObject({
    role: 'arn:aws:mock::123:defaults-execution',
    timeout: 120,
    memorySize: 256,
    environment: { variables: { PULUMI_API_URL: 'https://api.pulumi.com' } },
  });
});
