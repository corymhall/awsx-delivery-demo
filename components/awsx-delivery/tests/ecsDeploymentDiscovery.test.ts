import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const scripts = path.join(__dirname, '../src/scripts');
const pipeline = 'acme/pipeline/dev';
const task = 'arn:aws:ecs:us-east-2:123456789012:task-definition/app:1';
const arn = 'arn:aws:ecs:us-east-2:123456789012:service-deployment/cluster/app/new';

/**
 * Build an ECS hook carrying a Delivery run identity.
 *
 * @param run Delivery run number.
 * @returns The hook payload used in fake AWS responses.
 */
function hook(run: string): {
  hookDetails: {
    call: {
      service: string;
      action: string;
      parameters: { organization: string; project: string; stack: string; stage: string };
      request: { runNumber: string; condition: string };
    };
  };
} {
  return {
    hookDetails: {
      call: {
        service: 'Delivery',
        action: 'ContinueManualGate',
        parameters: {
          organization: 'acme',
          project: 'pipeline',
          stack: 'dev',
          stage: 'checkpoint',
        },
        request: { runNumber: run, condition: 'pause-hook' },
      },
    },
  };
}

/**
 * Build settled ECS history and service state that confirm this run is a no-op.
 *
 * @returns Independent AWS response fixtures for one test.
 */
function responses(): {
  'list-service-deployments': {
    serviceDeployments: {
      serviceDeploymentArn: string;
      createdAt: number;
      status: string;
      targetServiceRevisionArn: string;
    }[];
  };
  'describe-service-deployments': {
    serviceDeployments: {
      serviceDeploymentArn: string;
      deploymentConfiguration: { lifecycleHooks: ReturnType<typeof hook>[] };
    }[];
    failures: { reason: string }[];
  };
  'describe-services': {
    services: {
      status: string;
      taskDefinition: string;
      desiredCount: number;
      runningCount: number;
      pendingCount: number;
      deploymentConfiguration: { lifecycleHooks: ReturnType<typeof hook>[] };
    }[];
  };
  'describe-service-revisions': { serviceRevisions: { taskDefinition: string }[] };
} {
  return {
    'list-service-deployments': {
      serviceDeployments: [
        {
          serviceDeploymentArn: arn,
          createdAt: 1,
          status: 'SUCCESSFUL',
          targetServiceRevisionArn: 'revision',
        },
      ],
    },
    'describe-service-deployments': {
      serviceDeployments: [
        {
          serviceDeploymentArn: arn,
          deploymentConfiguration: { lifecycleHooks: [hook('10')] },
        },
      ],
      failures: [],
    },
    'describe-services': {
      services: [
        {
          status: 'ACTIVE',
          taskDefinition: task,
          desiredCount: 1,
          runningCount: 1,
          pendingCount: 0,
          deploymentConfiguration: { lifecycleHooks: [hook('11')] },
        },
      ],
    },
    'describe-service-revisions': { serviceRevisions: [{ taskDefinition: task }] },
  };
}

type Responses = ReturnType<typeof responses>;

/**
 * Execute the real discovery scripts with fake AWS and sleep executables.
 *
 * @param data AWS CLI responses keyed by operation.
 * @param failingOperation Optional operation that should exit with an AWS CLI error.
 * @returns The script result, published outputs, and recorded AWS operations.
 */
function discover(
  data: Responses,
  failingOperation = '',
): {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string> | null;
  calls: string[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-discovery-'));
  try {
    fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(data));
    fs.writeFileSync(
      path.join(root, 'aws'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.MOCK_ROOT;
const [service, operation] = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), operation + '\\n');
if (service === 'sts' && operation === 'get-caller-identity') {
  console.log('{}');
  process.exit(0);
}
if (operation === process.env.MOCK_FAIL_OPERATION) process.exit(254);
const responses = JSON.parse(fs.readFileSync(path.join(root, 'responses.json'), 'utf8'));
if (!(operation in responses)) throw new Error('Unexpected AWS operation: ' + operation);
console.log(JSON.stringify(responses[operation]));
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const outputsPath = path.join(root, 'outputs.json');
    const result = spawnSync('bash', [path.join(scripts, 'discover-ecs-deployment.sh')], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        MOCK_ROOT: root,
        MOCK_FAIL_OPERATION: failingOperation,
        ECS_CLUSTER: 'cluster',
        ECS_SERVICE: 'app',
        ECS_TASK_DEFINITION: task,
        DELIVERY_PIPELINE: pipeline,
        DELIVERY_RUN: '11',
        DELIVERY_STAGE: 'dev',
        ECS_GATE_STAGE: 'checkpoint',
        ECS_GATE_CONDITION: 'pause-hook',
        DELIVERY_OUTPUTS: outputsPath,
      },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: fs.existsSync(outputsPath) ? JSON.parse(fs.readFileSync(outputsPath, 'utf8')) : null,
      calls: fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n'),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('verified no-op skips approval only after rechecks', () => {
  const result = discover(responses());
  expect({ status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
  expect(result.outputs).toEqual({ result: 'no-deployment', deploymentArn: '' });
  expect(result.calls.filter((operation) => operation === 'list-service-deployments')).toHaveLength(
    3,
  );
});

test('matching deployment requires approval and preserves its ARN', () => {
  const data = responses();
  data[
    'describe-service-deployments'
  ].serviceDeployments[0]!.deploymentConfiguration.lifecycleHooks = [hook('11')];
  const result = discover(data);
  expect({ status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
  expect(result.outputs).toEqual({ result: 'deployment', deploymentArn: arn });
  expect(result.calls).not.toContain('describe-services');
});

const mutations: { name: string; mutate: (data: Responses) => void }[] = [
  {
    name: 'active deployment',
    mutate: (data) => {
      data['list-service-deployments'].serviceDeployments[0]!.status = 'IN_PROGRESS';
    },
  },
  {
    name: 'rollback',
    mutate: (data) => {
      data['list-service-deployments'].serviceDeployments[0]!.status = 'ROLLBACK_SUCCESSFUL';
    },
  },
  {
    name: 'no history',
    mutate: (data) => {
      data['list-service-deployments'].serviceDeployments = [];
    },
  },
  {
    name: 'stale service',
    mutate: (data) => {
      data['describe-services'].services[0]!.taskDefinition = 'old';
    },
  },
  {
    name: 'unhealthy service',
    mutate: (data) => {
      data['describe-services'].services[0]!.runningCount = 0;
    },
  },
  {
    name: 'stale hook',
    mutate: (data) => {
      data['describe-services'].services[0]!.deploymentConfiguration.lifecycleHooks = [hook('10')];
    },
  },
  {
    name: 'wrong condition',
    mutate: (data) => {
      data[
        'describe-services'
      ].services[0]!.deploymentConfiguration.lifecycleHooks[0]!.hookDetails.call.request.condition =
        'another-hook';
    },
  },
  {
    name: 'old deployed task',
    mutate: (data) => {
      data['describe-service-revisions'].serviceRevisions[0]!.taskDefinition = 'old';
    },
  },
  {
    name: 'describe failure',
    mutate: (data) => {
      data['describe-service-deployments'].failures = [{ reason: 'MISSING' }];
    },
  },
  {
    name: 'multiple matches',
    mutate: (data) => {
      data['describe-service-deployments'].serviceDeployments = [arn, `${arn}2`].map(
        (serviceDeploymentArn) => ({
          serviceDeploymentArn,
          deploymentConfiguration: { lifecycleHooks: [hook('11')] },
        }),
      );
    },
  },
];

test.each(mutations)('$name never publishes a no-op', ({ mutate }) => {
  const data = responses();
  mutate(data);
  const result = discover(data);
  expect(result.status).not.toBeNull();
  expect(result.status).not.toBe(0);
  expect(result.outputs).toBeNull();
});

test('AWS failure never publishes a no-op', () => {
  const result = discover(responses(), 'list-service-deployments');
  expect(result.status).not.toBeNull();
  expect(result.status).not.toBe(0);
  expect(result.outputs).toBeNull();
});
