import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { EcsDeploymentCheckpoint } from '../src/ecsDeploymentCheckpoint';

const resources: pulumi.runtime.MockResourceArgs[] = [];
const arn = 'arn:aws:ecs:us-east-2:123456789012:service-deployment/cluster/app/new';
pulumi.runtime.setMocks({
  newResource(args) {
    resources.push(args);
    const outputs = args.name.startsWith('noop-')
      ? { result: 'no-deployment', deploymentArn: '' }
      : { result: 'deployment', deploymentArn: arn };
    return { id: args.name, state: { ...args.inputs, outputs } };
  },
  call(args) {
    if (args.token === 'delivery:index:approval') return { kind: 'approval', ...args.inputs };
    if (args.token === 'delivery:index:manual') return { kind: 'manual', ...args.inputs };
    if (args.token === 'delivery:index:allOf') return { kind: 'all', ...args.inputs };
    return args.inputs;
  },
});

/**
 * Await a Pulumi output.
 *
 * @param value Output to resolve.
 * @returns Its resolved value.
 */
function resolve<T>(value: pulumi.Output<T>): Promise<T> {
  return new Promise((done) => {
    value.apply((result) => {
      done(result);
    });
  });
}

const source = new delivery.GitHubSource('source', { repository: 'acme/app', branch: 'main' });
const pipeline = new delivery.Pipeline('app', { program: { directory: '.', source } });
const upstream = new delivery.Stage('infra', { pipeline });

/**
 * Construct a checkpoint using only existing resource identifiers.
 *
 * @param name Checkpoint stage name.
 * @param automatedTest Optional test Job settings.
 * @param automatedTest.command Test command.
 * @param automatedTest.directory Test directory.
 * @param conditionName Optional custom arrival condition.
 * @returns The checkpoint component.
 */
function create(
  name: string,
  automatedTest?: { command: string; directory?: string },
  conditionName?: string,
): EcsDeploymentCheckpoint {
  return new EcsDeploymentCheckpoint(name, {
    pipelineUrn: pipeline.urn,
    upstreamStageUrn: upstream.urn,
    sourceUrn: source.urn,
    conditionName,
    serviceArn: pulumi.output('arn:aws:ecs:us-east-2:123456789012:service/cluster/app'),
    taskDefinitionArn: 'task:1',
    environment: 'app/dev',
    automatedTest,
  });
}

test.each(['deploy', 'noop'])(
  '%s chooses the correct continuation without bypassing promotion approval',
  async (name) => {
    const component = create(name);
    const continuationUrn = await resolve(component.continuationStageUrn);
    const stage = resources.find((r) => r.type === 'delivery:index:Stage' && r.name === name);
    const job = resources.find(
      (r) => r.type === 'delivery:index:Job' && r.name === `${name}-verify`,
    );
    const discovery = resources.find((r) => r.name === `${name}-discover`)!;
    expect(discovery.inputs.environment).toMatchObject({
      ECS_GATE_STAGE: name,
      ECS_GATE_CONDITION: 'ecs-arrival',
      AWS_REGION: 'us-east-2',
      ECS_CLUSTER: 'arn:aws:ecs:us-east-2:123456789012:cluster/cluster',
      ECS_SERVICE: 'app',
      ECS_TASK_DEFINITION: 'task:1',
    });
    if (name === 'noop') {
      expect(stage).toBeUndefined();
      expect(job).toBeUndefined();
      expect(await resolve(component.stageUrn)).toBeUndefined();
      expect(await resolve(component.verificationJobUrn)).toBeUndefined();
      expect(continuationUrn).toBe(await resolve(upstream.urn));
    } else {
      expect(job!.inputs.environment.ECS_DEPLOYMENT_ARN).toBe(arn);
      expect(job!.inputs.environment.AWS_REGION).toBe('us-east-2');
      expect(stage!.inputs.when).toMatchObject({
        kind: 'all',
        rules: [{ kind: 'approval' }, { kind: 'manual', name: 'ecs-arrival' }],
      });
      expect(continuationUrn).toBe(await resolve(component.stageUrn));
      expect(await resolve(component.verificationJobUrn)).toContain(`${name}-verify`);
    }
    const predecessor = new delivery.Stage(`${name}-predecessor-reference`, undefined!, {
      urn: continuationUrn,
    });
    const promotion = new delivery.Stage(`${name}-promotion`, {
      pipeline,
      from: [predecessor],
      when: delivery.approvalOutput({ name: 'promote-prod' }),
    });
    await resolve(promotion.urn);
    const promotionInputs = resources.find((r) => r.name === `${name}-promotion`)!.inputs;
    expect(promotionInputs.when).toMatchObject({ kind: 'approval', name: 'promote-prod' });
    expect(await resolve(promotionInputs.from[0].urn)).toBe(continuationUrn);
    expect(
      resources.filter((r) =>
        ['delivery:index:Pipeline', 'delivery:index:GitHubSource'].includes(r.type),
      ),
    ).toHaveLength(2);
  },
);

test('automated tests run after arrival and verification runs in a later stage', async () => {
  const component = create('automated', { command: 'node --test' });
  const continuation = await resolve(component.continuationStageUrn);
  const stage = resources.find((r) => r.type === 'delivery:index:Stage' && r.name === 'automated')!;
  const verifyStage = resources.find(
    (r) => r.type === 'delivery:index:Stage' && r.name === 'automated-verify',
  )!;
  const testJob = resources.find(
    (r) => r.type === 'delivery:index:Job' && r.name === 'automated-test',
  )!;
  const verifyJob = resources.find(
    (r) => r.type === 'delivery:index:Job' && r.name === 'automated-verify',
  )!;
  expect(stage.inputs.when).toMatchObject({ kind: 'manual', name: 'ecs-arrival' });
  expect(testJob.inputs.command).toBe('node --test');
  expect(testJob.inputs.directory).toBe('.');
  expect(await resolve(testJob.inputs.stage.urn)).toBe(await resolve(component.stageUrn));
  expect(await resolve(verifyStage.inputs.from[0].urn)).toBe(await resolve(component.stageUrn));
  expect(await resolve(verifyJob.inputs.stage.urn)).toBe(continuation);
  expect(continuation).toContain('automated-verify');
});

test('custom test directories and arrival conditions reach both discovery and the gate', async () => {
  const component = create(
    'custom',
    { command: 'node --test', directory: 'app' },
    'custom-arrival',
  );
  await resolve(component.continuationStageUrn);
  expect(
    resources.find((r) => r.name === 'custom-discover')!.inputs.environment.ECS_GATE_CONDITION,
  ).toBe('custom-arrival');
  expect(
    resources.find((r) => r.name === 'custom' && r.type === 'delivery:index:Stage')!.inputs.when,
  ).toMatchObject({
    kind: 'manual',
    name: 'custom-arrival',
  });
  expect(resources.find((r) => r.name === 'custom-test')!.inputs.directory).toBe('app');
});

test('a verified no-op skips the automated test and verification stages', async () => {
  const component = create('noop-automated', { command: 'node --test', directory: 'app' });
  expect(await resolve(component.continuationStageUrn)).toBe(await resolve(upstream.urn));
  expect(
    resources.some((r) => ['noop-automated-test', 'noop-automated-verify'].includes(r.name)),
  ).toBe(false);
});

test('embedded polling scripts run without consumer files and quote ESC environment names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-checkpoint-'));
  try {
    fs.writeFileSync(
      path.join(root, 'pulumi'),
      '#!/bin/bash\nset -eu\n[[ "$1" == env && "$2" == run && "$3" == "$ECS_ESC_ENVIRONMENT" && "$4" == -- ]]\nshift 4\nexport AWS_REGION=wrong-region AWS_DEFAULT_REGION=wrong-region\nexec "$@"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(root, 'aws'),
      '#!/bin/bash\n[[ "$AWS_REGION" == us-east-2 && "$AWS_DEFAULT_REGION" == us-east-2 ]] || exit 1\nprintf "SUCCESSFUL\\n"\n',
      {
        mode: 0o755,
      },
    );
    const command = resources.find((r) => r.name === 'deploy-verify')!.inputs.command;
    const result = spawnSync('sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        ECS_ESC_ENVIRONMENT: 'app/dev; exit 1',
        AWS_REGION: 'us-east-2',
        ECS_DEPLOYMENT_ARN: arn,
        ECS_WAIT_TIMEOUT_SECONDS: '5',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${arn}: SUCCESSFUL`);
    expect(new Set(fs.readdirSync(root))).toEqual(new Set(['aws', 'pulumi']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
