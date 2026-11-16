import { HttpError } from './authentication.js';

export interface ApiCall {
  service: 'Delivery';
  action: 'ContinueManualGate';
  waitForApproval?: boolean;
  waitForStage?: boolean;
  parameters: {
    organization: string;
    project: string;
    stack: string;
    stage: string;
  };
  request: {
    runNumber: string;
    condition: string;
  };
}

interface Gate {
  id: string;
  stageName: string;
  status: string;
  closeReason?: string;
  passedAt?: string;
  conditions?: Array<{ name: string; kind: string; state: string }>;
}

export function parseCall(value: unknown, organization: string): ApiCall {
  const call = value as ApiCall | undefined;
  if (call?.service !== 'Delivery' || call.action !== 'ContinueManualGate') {
    throw new Error('Only Delivery.ContinueManualGate is supported');
  }
  for (const key of ['organization', 'project', 'stack', 'stage'] as const) {
    if (typeof call.parameters?.[key] !== 'string' || !call.parameters[key]) {
      throw new Error(`Missing call.parameters.${key}`);
    }
  }
  if (call.waitForApproval !== undefined && typeof call.waitForApproval !== 'boolean') {
    throw new Error('call.waitForApproval must be a boolean');
  }
  if (call.waitForStage !== undefined && typeof call.waitForStage !== 'boolean') {
    throw new Error('call.waitForStage must be a boolean');
  }
  if (call.waitForStage && !call.waitForApproval) {
    throw new Error('Waiting for a stage requires waiting for its gate');
  }
  if (call.parameters.organization !== organization) {
    throw new Error('The call organization must match the configured organization');
  }
  for (const key of ['runNumber', 'condition'] as const) {
    if (typeof call.request?.[key] !== 'string' || !call.request[key]) {
      throw new Error(`Missing call.request.${key}`);
    }
  }
  if (
    !/^[1-9]\d*$/.test(call.request.runNumber) ||
    !Number.isSafeInteger(Number(call.request.runNumber))
  ) {
    throw new Error('call.request.runNumber must be a positive integer string');
  }
  return call;
}

function isSatisfied(gate: Gate, conditionName: string): boolean {
  if (gate.status === 'closed' && !['stage_converged', 'ended'].includes(gate.closeReason ?? '')) {
    throw new Error('Delivery gate closed without completing');
  }
  if (gate.conditions?.some((condition) => condition.state === 'rejected')) {
    throw new Error('Delivery gate was rejected');
  }
  const condition = gate.conditions?.find((candidate) => candidate.name === conditionName);
  if (!condition || condition.kind !== 'manual') {
    throw new Error('Delivery gate has no matching manual condition');
  }
  if (condition.state === 'satisfied') return true;
  if (condition.state !== 'pending' || gate.status !== 'open') {
    throw new Error('Delivery manual condition cannot be continued');
  }
  return false;
}

function isApproved(gate: Gate): boolean {
  if (gate.status === 'passed') return true;
  if (gate.status === 'closed') {
    if (gate.passedAt) return true;
    throw new Error('Delivery gate closed without passing');
  }
  if (gate.status !== 'open') throw new Error('Unknown Delivery gate status');
  return false;
}

// Returns false while waiting for the gate or its approval. ECS supplies the callback retry.
export async function invoke(apiUrl: string, token: string, call: ApiCall): Promise<boolean> {
  const { organization, project, stack, stage } = call.parameters;
  const target = [organization, project, stack].map(encodeURIComponent).join('/');
  const base = `${apiUrl}/api/preview/stacks/${target}/delivery/runs/${call.request.runNumber}`;
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };

  async function readGate(): Promise<{ gate?: Gate; stageStatus?: string }> {
    const response = await fetch(base, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new HttpError(response.status);
    const run = (await response.json()) as {
      summary?: { number: number; status: { status: string } };
      stages?: Array<{ name: string; gate?: Gate; status?: { status?: string } }>;
    };
    if (
      run.summary?.number !== Number(call.request.runNumber) ||
      !['in_progress', 'waiting', 'succeeded'].includes(run.summary?.status?.status ?? '')
    ) {
      throw new Error('Delivery run is not active or successful');
    }
    const stages = run.stages?.filter((candidate) => candidate.name === stage) ?? [];
    if (stages.length > 1) throw new Error('Delivery run has duplicate matching stages');
    const gate = stages[0]?.gate;
    if (gate && (!gate.id || gate.stageName !== stage)) {
      throw new Error('Delivery gate does not match the configured stage');
    }
    if (!gate && run.summary.status.status === 'succeeded') {
      throw new Error('Completed Delivery run has no matching gate');
    }
    return { gate, stageStatus: stages[0]?.status?.status };
  }

  function completed(gate: Gate, stageStatus?: string): boolean {
    if (!call.waitForApproval) return true;
    if (!isApproved(gate)) return false;
    if (!call.waitForStage) return true;
    if (stageStatus === 'succeeded') return true;
    if (stageStatus && ['pending', 'waiting', 'running'].includes(stageStatus)) return false;
    throw new Error('Delivery test stage did not succeed');
  }

  const currentRun = await readGate();
  const gate = currentRun.gate;
  if (!gate) return false;
  if (isSatisfied(gate, call.request.condition)) {
    return completed(gate, currentRun.stageStatus);
  }

  const response = await fetch(`${base}/gates/${encodeURIComponent(gate.id)}/continue`, {
    method: 'POST',
    headers,
    redirect: 'error',
    body: JSON.stringify({ condition: call.request.condition }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 409) {
    // A concurrent continuation may have succeeded. Confirm the condition before accepting a conflict.
    const current = await readGate();
    if (current.gate?.id === gate.id && isSatisfied(current.gate, call.request.condition)) {
      return completed(current.gate, current.stageStatus);
    }
  }
  if (!response.ok) throw new HttpError(response.status);
  // On the next callback, read the gate's decision instead of posting the notification again.
  return !call.waitForApproval;
}
