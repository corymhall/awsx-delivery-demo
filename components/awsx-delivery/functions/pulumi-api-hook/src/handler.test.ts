import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from './authentication.js';
import { STSClient } from '@aws-sdk/client-sts';
import { handler, isRetryable, retryResult } from './handler.js';
import { invoke, parseCall } from './invoke.js';

const call = {
  service: 'Delivery',
  action: 'ContinueManualGate',
  parameters: { organization: 'acme', project: 'delivery', stack: 'main', stage: 'checkpoint' },
  request: { runNumber: '42', condition: 'ecs-ready' },
};
const parsedCall = parseCall(call, 'acme');
const base = 'https://api.example.com/api/preview/stacks/acme/delivery/main/delivery/runs/42';
const gate = {
  id: 'gate-1',
  stageName: 'checkpoint',
  status: 'open',
  conditions: [
    { name: 'approval', kind: 'approval', state: 'pending' },
    { name: 'ecs-ready', kind: 'manual', state: 'pending' },
    { name: 'other-check', kind: 'manual', state: 'pending' },
  ],
};

function runResponse(currentGate: unknown = gate, status = 'waiting', number = 42): Response {
  return Response.json({
    summary: { number, status: { status } },
    stages: [
      { name: 'other-stage', gate: { ...gate, id: 'other-gate', stageName: 'other-stage' } },
      { name: 'checkpoint', gate: currentGate },
    ],
  });
}

function satisfiedGate() {
  return {
    ...gate,
    conditions: gate.conditions.map((condition) =>
      condition.name === 'ecs-ready' ? { ...condition, state: 'satisfied' } : condition,
    ),
  };
}

test('automated mode waits for test stage success and fails closed on terminal or unknown statuses', async (t) => {
  const automated = parseCall({ ...call, waitForApproval: true, waitForStage: true }, 'acme');
  let status = 'running';
  const passedGate = { ...satisfiedGate(), status: 'passed' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    summary: { number: 42, status: { status: 'in_progress' } },
    stages: [{ name: 'checkpoint', gate: passedGate, status: { status } }],
  }));
  assert.equal(await invoke('https://api.example.com', 'token', automated), false);
  status = 'succeeded';
  assert.equal(await invoke('https://api.example.com', 'token', automated), true);
  for (const terminal of ['failed', 'canceled', 'skipped', 'closed', 'unknown']) {
    status = terminal;
    await assert.rejects(invoke('https://api.example.com', 'token', automated), /did not succeed/);
  }
  assert.throws(() => parseCall({ ...call, waitForStage: true }, 'acme'), /requires waiting/);
});

const isHttpError = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status && !error.message.includes('sensitive');

test('retries preserve call configuration and the original deadline', () => {
  const first = retryResult({ hookDetails: { call } }, 1000);
  assert.equal(first.hookStatus, 'IN_PROGRESS');
  assert.deepEqual(first.hookDetails?.call, call);
  const second = retryResult({ hookDetails: first.hookDetails }, 2000);
  assert.equal(second.hookDetails?.retryState?.startedAt, 1000);
  assert.equal(
    retryResult({ hookDetails: second.hookDetails }, 1000 + 30 * 60 * 1000).hookStatus,
    'FAILED',
  );
  assert.equal(
    retryResult({ hookDetails: { retryState: { startedAt: 3000 } } }, 2000).hookStatus,
    'FAILED',
  );
});

test('only transient HTTP failures retry without inspecting Delivery state', () => {
  for (const status of [400, 401, 403, 404, 409]) {
    assert.equal(isRetryable(new HttpError(status)), false);
  }
  for (const status of [429, 503]) assert.equal(isRetryable(new HttpError(status)), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
  assert.equal(isRetryable(new Error('invalid configuration')), false);
});

test('explicit manual mode succeeds without Delivery configuration or network calls', async (t) => {
  const previous = {
    PULUMI_ORGANIZATION: process.env.PULUMI_ORGANIZATION,
    PULUMI_TEAM: process.env.PULUMI_TEAM,
  };
  delete process.env.PULUMI_ORGANIZATION;
  delete process.env.PULUMI_TEAM;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let authenticationCalls = 0;
  let httpCalls = 0;
  t.mock.method(STSClient.prototype, 'send', async () => {
    authenticationCalls++;
    throw new Error('Manual mode must not authenticate');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    httpCalls++;
    throw new Error('Manual mode must not make HTTP requests');
  });

  assert.deepEqual(await handler({ hookDetails: { mode: 'manual' } }), { hookStatus: 'SUCCEEDED' });
  assert.deepEqual(
    await handler({ hookDetails: { mode: 'manual', retryState: { startedAt: 0 } } }),
    { hookStatus: 'SUCCEEDED' },
  );
  assert.equal(authenticationCalls, 0);
  assert.equal(httpCalls, 0);
});

test('malformed Delivery identity and ambiguous modes fail closed before network calls', async (t) => {
  const previous = {
    PULUMI_ORGANIZATION: process.env.PULUMI_ORGANIZATION,
    PULUMI_TEAM: process.env.PULUMI_TEAM,
  };
  process.env.PULUMI_ORGANIZATION = 'acme';
  process.env.PULUMI_TEAM = 'delivery';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let authenticationCalls = 0;
  let httpCalls = 0;
  t.mock.method(STSClient.prototype, 'send', async () => {
    authenticationCalls++;
    throw new Error('Invalid configuration must not authenticate');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    httpCalls++;
    throw new Error('Invalid configuration must not make HTTP requests');
  });
  const invalidEvents = [
    {},
    { hookDetails: null },
    { hookDetails: {} },
    { hookDetails: { mode: 'delivery' } },
    { hookDetails: { mode: 'Manual', call } },
    { hookDetails: { mode: null, call } },
    { hookDetails: { mode: 'manual', call } },
    { hookDetails: { mode: 'manual', call: null } },
    { hookDetails: { call: { ...call, request: { condition: 'ecs-ready' } } } },
    { hookDetails: { mode: 'delivery', call: { ...call, parameters: {} } } },
    {
      hookDetails: {
        mode: 'delivery',
        call: { ...call, parameters: { ...call.parameters, organization: 'other' } },
      },
    },
  ];
  for (const event of invalidEvents) {
    assert.deepEqual(await handler(event as Parameters<typeof handler>[0]), { hookStatus: 'FAILED' });
  }
  assert.equal(authenticationCalls, 0);
  assert.equal(httpCalls, 0);
});

test('validates the operation, organization, run number, and condition', () => {
  assert.throws(
    () => parseCall({ ...call, action: 'SignalStage' }, 'acme'),
    /Only Delivery.ContinueManualGate/,
  );
  assert.throws(() => parseCall(call, 'other'), /organization must match/);
  assert.throws(() => parseCall({ ...call, request: {} }, 'acme'), /runNumber/);
  for (const runNumber of [42, '0', '-1', '1.5', '42/other', '9007199254740992']) {
    assert.throws(
      () => parseCall({ ...call, request: { ...call.request, runNumber } }, 'acme'),
      /runNumber/,
    );
  }
  assert.throws(() => parseCall({ ...call, request: { runNumber: '42' } }, 'acme'), /condition/);
  for (const waitForApproval of ['true', 1, null]) {
    assert.throws(() => parseCall({ ...call, waitForApproval }, 'acme'), /waitForApproval/);
  }
});

test('continues only the configured manual condition of the exact run and stage', async (t) => {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push({ url, options });
    return requests.length === 1 ? runResponse() : Response.json({ status: 'open' });
  });
  const input = parseCall({
    ...call,
    waitForApproval: false,
    request: { ...call.request, extra: 'not forwarded' },
  }, 'acme');
  assert.equal(await invoke('https://api.example.com', 'test-token', input), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, base);
  assert.equal(requests[1].url, `${base}/gates/gate-1/continue`);
  assert.equal(requests[1].options?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1].options?.body)), { condition: 'ecs-ready' });
});

test('waits for a gate without posting to another stage', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return runResponse(null);
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), false);
  assert.equal(requests, 1);
});

test('recognizes a satisfied manual condition without waiting for human approval', async (t) => {
  let requests = 0;
  let response = runResponse(satisfiedGate());
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return response;
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), true);
  response = runResponse({ ...satisfiedGate(), status: 'passed' });
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), true);
  response = runResponse(
    { ...satisfiedGate(), status: 'closed', closeReason: 'stage_converged' },
    'succeeded',
  );
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), true);
  assert.equal(requests, 3);
});

test('does not continue canceled, superseded, failed, or mismatched runs', async (t) => {
  let response: Response;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return response;
  });
  for (const status of ['canceled', 'superseded', 'failed']) {
    response = runResponse(satisfiedGate(), status);
    await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), /run is not active/);
  }
  response = runResponse(gate, 'waiting', 43);
  await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), /run is not active/);
  response = runResponse(null, 'succeeded');
  await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), /no matching gate/);
  assert.equal(requests, 5);
});

test('rejects closed gates, rejected conditions, and approval conditions', async (t) => {
  const invalidGates = [
    { ...satisfiedGate(), status: 'closed', closeReason: 'superseded' },
    { ...gate, conditions: [{ name: 'ecs-ready', kind: 'manual', state: 'rejected' }] },
    { ...gate, conditions: [{ name: 'ecs-ready', kind: 'approval', state: 'pending' }] },
    { ...gate, conditions: [] },
    { ...gate, stageName: 'other-stage' },
  ];
  let current: unknown;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return runResponse(current);
  });
  for (current of invalidGates) {
    await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall));
  }
  assert.equal(requests, invalidGates.length);
});

test('conflicts require confirmation that the same gate condition was satisfied', async (t) => {
  let requests = 0;
  let current = satisfiedGate();
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests % 3 === 1) return runResponse();
    if (requests % 3 === 2) return new Response('sensitive body', { status: 409 });
    return runResponse(current);
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), true);
  current = gate;
  await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), isHttpError(409));
  current = { ...satisfiedGate(), id: 'new-round' };
  await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), isHttpError(409));
});

test('recovers a lost continuation response without posting again', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests === 1) return runResponse();
    if (requests === 2) throw new TypeError('fetch failed');
    return runResponse(satisfiedGate());
  });
  await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), TypeError);
  assert.equal(await invoke('https://api.example.com', 'test-token', parsedCall), true);
  assert.equal(requests, 3);
});

test('wait mode notifies once and waits for the whole gate, not just its manual condition', async (t) => {
  const waitingCall = parseCall({ ...call, waitForApproval: true }, 'acme');
  let current = gate;
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      posts++;
      current = satisfiedGate();
      return Response.json({ status: 'open' });
    }
    return runResponse(current);
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), false);
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), false);
  current = {
    ...current,
    conditions: current.conditions.map((condition) =>
      condition.kind === 'approval' ? { ...condition, state: 'satisfied' } : condition,
    ),
  };
  // Another manual check is still pending, so an approval alone does not release ECS.
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), false);
  current = { ...current, status: 'passed' };
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), true);
  assert.equal(posts, 1);
});

test('wait mode accepts closed gates only with a recorded pass', async (t) => {
  const waitingCall = parseCall({ ...call, waitForApproval: true }, 'acme');
  let response = runResponse({ ...satisfiedGate(), status: 'closed', closeReason: 'stage_converged' });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(
    invoke('https://api.example.com', 'test-token', waitingCall),
    /closed without passing/,
  );
  response = runResponse({
    ...satisfiedGate(),
    status: 'closed',
    closeReason: 'stage_converged',
    passedAt: '2026-11-04T15:00:00Z',
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), true);
});

test('wait mode does not mistake a duplicate manual notification for approval', async (t) => {
  const waitingCall = parseCall({ ...call, waitForApproval: true }, 'acme');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests === 1) return runResponse();
    if (requests === 2) return new Response(null, { status: 409 });
    return runResponse(satisfiedGate());
  });
  assert.equal(await invoke('https://api.example.com', 'test-token', waitingCall), false);
  assert.equal(requests, 3);
});

test('handler waits between callbacks and returns FAILED on approval rejection', async (t) => {
  const environment = {
    PULUMI_ORGANIZATION: 'acme',
    PULUMI_TEAM: 'delivery',
    PULUMI_API_URL: 'https://api.example.com',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(STSClient.prototype, 'send', async () => ({ WebIdentityToken: 'test-identity' }));
  let current = satisfiedGate();
  let status = 'waiting';
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('/api/oauth/token')
      ? Response.json({ access_token: 'test-token' })
      : runResponse(current, status),
  );
  const waitingCall = { ...call, waitForApproval: true };
  const first = await handler({ hookDetails: { mode: 'delivery', call: waitingCall } });
  assert.equal(first.hookStatus, 'IN_PROGRESS');
  assert.equal(first.callBackDelay, 30);
  assert.deepEqual(first.hookDetails?.call, waitingCall);
  assert.equal(first.hookDetails?.mode, 'delivery');
  const second = await handler({ hookDetails: first.hookDetails });
  assert.equal(second.hookStatus, 'IN_PROGRESS');
  assert.equal(second.hookDetails?.mode, 'delivery');
  assert.equal(second.hookDetails?.retryState?.startedAt, first.hookDetails?.retryState?.startedAt);

  // Rejection can be visible before the run finishes transitioning to failed.
  current = {
    ...current,
    conditions: current.conditions.map((condition) =>
      condition.kind === 'approval' ? { ...condition, state: 'rejected' } : condition,
    ),
  };
  assert.deepEqual(await handler({ hookDetails: second.hookDetails }), { hookStatus: 'FAILED' });

  for (status of ['canceled', 'superseded', 'failed']) {
    current = satisfiedGate();
    assert.deepEqual(await handler({ hookDetails: second.hookDetails }), { hookStatus: 'FAILED' });
  }
  status = 'waiting';
  current = { ...satisfiedGate(), status: 'passed' };
  assert.deepEqual(await handler({ hookDetails: second.hookDetails }), { hookStatus: 'SUCCEEDED' });
  assert.deepEqual(await handler({ hookDetails: { call: waitingCall } }), { hookStatus: 'SUCCEEDED' });
  const expired = { ...second.hookDetails, retryState: { startedAt: Date.now() - 30 * 60 * 1000 } };
  assert.deepEqual(await handler({ hookDetails: expired }), { hookStatus: 'FAILED' });
});

test('missing runs and HTTP failures are surfaced without response bodies', async (t) => {
  let status = 404;
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive response body', { status }));
  for (status of [404, 429, 503]) {
    await assert.rejects(invoke('https://api.example.com', 'test-token', parsedCall), isHttpError(status));
  }
});
