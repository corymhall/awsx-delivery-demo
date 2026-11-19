import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const productionEndpointArn =
  'arn:aws:lambda:us-east-2:123456789012:webfunction:dashboard-generated:endpoint:production-generated';
let directory: string;
let outputs: string;
const runner = join(__dirname, '../src/scripts/web-function-canary.cjs');
const functionArn = 'arn:aws:lambda:us-east-2:123456789012:webfunction:dashboard-generated';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'web-function-canary-'));
  outputs = join(directory, 'outputs');
  writeFileSync(
    join(directory, 'pulumi'),
    `#!/bin/sh
[ "$*" = 'stack output --json --stack acme/dashboard/dev' ] || exit 2
[ "$TEST_STACK_ERROR" != '1' ] || exit 3
printf '%s\\n' "$TEST_STACK_OUTPUTS"
`,
    { mode: 0o755 },
  );
  const sdk = join(directory, '@aws-sdk/client-lambda-web');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, 'index.js'),
    `
    class ResourceNotFoundException extends Error {}
    module.exports = {
      ResourceNotFoundException,
      GetWebFunctionEndpointCommand: class { constructor(input) { this.input = input; } },
      LambdaWebClient: class {
        constructor({region}) {
          if (region !== 'us-east-2') throw new Error('wrong home Region: ' + region);
        }
        async send({input}) {
          if (input.endpointName !== '${productionEndpointArn}') throw new Error('wrong endpoint');
          if (input.functionName !== '${functionArn}') throw new Error('expected the generated function ARN');
          if (process.env.TEST_NO_AWS === '1') throw new Error('bootstrap must not query AWS');
          const weights = JSON.parse(process.env.TEST_WEIGHTS);
          if (!weights) throw new ResourceNotFoundException();
          return {state: 'Active', updateStatus: 'Successful', revisionWeights: Object.entries(weights)
            .map(([revisionId, weight]) => ({revisionId, weight}))};
        }
        destroy() {}
      },
    };
  `,
  );
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

/**
 * Execute the real runner with a fake AWS SDK and real verifier subprocess.
 *
 * @param mode Runner operation.
 * @param weights Simulated production routing.
 * @param overrides Environment for the case.
 * @returns Child exit status and logs.
 */
function run(
  mode: string,
  weights: Record<string, number> | null,
  overrides: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [runner, mode], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      NODE_PATH: directory,
      TEST_WEIGHTS: JSON.stringify(weights),
      DELIVERY_OUTPUTS: outputs,
      DELIVERY_COMMIT: 'source-commit',
      PATH: `${directory}:${process.env.PATH}`,
      CANARY_STACK: 'acme/dashboard/dev',
      TEST_STACK_OUTPUTS: JSON.stringify({
        functionArn,
        productionEndpointArn,
        candidateRevisionId: 'next',
      }),
      CANARY_FUNCTION_ARN: mode === 'snapshot' ? '' : functionArn,
      CANARY_PRODUCTION_ENDPOINT_ARN: productionEndpointArn,
      CANARY_CANDIDATE_REVISION_ID: 'next',
      CANARY_STABLE_REVISION_ID: 'previous',
      CANARY_PERCENT: '15',
      CANARY_BAKE_SECONDS: '0',
      CANARY_VERIFY_TIMEOUT_SECONDS: '1',
      CANARY_VERIFY_COMMAND: 'test -z "$DELIVERY_OUTPUTS"',
      ...overrides,
    },
  });
}

test('bootstrap discovers no baseline and verifies the already-created production endpoint', () => {
  expect(run('snapshot', null, { TEST_STACK_OUTPUTS: '{}', TEST_NO_AWS: '1' }).status).toBe(0);
  expect(JSON.parse(readFileSync(outputs, 'utf8'))).toEqual({
    functionArn: '',
    productionEndpointArn: '',
    stableRevisionId: '',
    releaseTag: 'source-commit',
  });
  expect(run('verify', { next: 100 }, { CANARY_STABLE_REVISION_ID: '' }).status).toBe(0);
  const observe = run(
    'observe',
    { next: 100 },
    {
      CANARY_STABLE_REVISION_ID: '',
      CANARY_VERIFY_COMMAND: 'exit 19',
    },
  );
  expect(observe.status).toBe(0);
  expect(JSON.parse(readFileSync(outputs, 'utf8')).verdict).toBe('promote');
});

test('snapshot reads stable routing from the generated ARN in the target stack outputs', () => {
  expect(run('snapshot', { live: 100 }).status).toBe(0);
  expect(JSON.parse(readFileSync(outputs, 'utf8'))).toEqual({
    functionArn,
    productionEndpointArn,
    stableRevisionId: 'live',
    releaseTag: 'source-commit',
  });
});

test.each([
  { TEST_STACK_ERROR: '1' },
  { TEST_STACK_OUTPUTS: '{"testUrl":"https://test.example"}' },
  { TEST_STACK_OUTPUTS: JSON.stringify({ functionArn, productionUrl: 'https://prod.example' }) },
  { TEST_STACK_OUTPUTS: JSON.stringify({ functionArn, productionEndpointArn }) },
] as Record<string, string>[])(
  'snapshot does not bootstrap when stack output discovery fails (%j)',
  (overrides) => {
    expect(run('snapshot', null, overrides).status).toBe(1);
    expect(existsSync(outputs)).toBe(false);
  },
);

test('bootstrap reports a failed verification without scheduling a rollback', () => {
  const result = run(
    'verify',
    { next: 100 },
    {
      CANARY_STABLE_REVISION_ID: '',
      CANARY_VERIFY_COMMAND: 'exit 1',
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('verification exited with 1');
  expect(existsSync(outputs)).toBe(false);
});

test('a healthy split produces a promote verdict and verifies full candidate routing', () => {
  expect(run('observe', { previous: 85, next: 15 }).status).toBe(0);
  expect(JSON.parse(readFileSync(outputs, 'utf8')).verdict).toBe('promote');
  const verdict = { CANARY_VERDICT: 'promote' };
  expect(run('shift-result', { previous: 85, next: 15 }, verdict).status).toBe(0);
  expect(run('shift-result', { previous: 100 }, verdict).status).toBe(1);
  expect(run('result', { next: 100 }).status).toBe(0);
});

test.each(['exit 7', 'sleep 10'])(
  'command failure (%s) produces a restore verdict without failing the job',
  (command) => {
    const observed = run('observe', { previous: 85, next: 15 }, { CANARY_VERIFY_COMMAND: command });
    expect(observed.status).toBe(0);
    const verdict = JSON.parse(readFileSync(outputs, 'utf8'));
    expect(verdict.verdict).toBe('restore');
    const result = run(
      'shift-result',
      { previous: 100 },
      { CANARY_VERDICT: verdict.verdict, CANARY_FAILURE_REASON: verdict.reason },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Restored stable revision previous');
  },
);

test('pre-shift rejects an approval if the published candidate or live baseline changed', () => {
  expect(run('pre-shift', { previous: 100 }).status).toBe(0);
  const stale = run(
    'pre-shift',
    { previous: 100 },
    {
      TEST_STACK_OUTPUTS: JSON.stringify({
        functionArn,
        productionEndpointArn,
        candidateRevisionId: 'other',
      }),
    },
  );
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain('no longer points to this release');
  expect(run('pre-shift', { other: 100 }).stderr).toContain('Unexpected production routing');
});

test('unexpected production routing never requests a write or claims restoration', () => {
  expect(run('observe', { previous: 85, different: 15 }).status).toBe(1);
  expect(existsSync(outputs)).toBe(false);
  const result = run(
    'shift-result',
    { next: 100 },
    { CANARY_VERDICT: 'restore', CANARY_FAILURE_REASON: 'check failed' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unexpected production routing');
  expect(result.stderr).not.toContain('Restored stable revision');
});
