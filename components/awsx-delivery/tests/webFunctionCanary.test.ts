import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { MockMonitor } from '@pulumi/pulumi/runtime/mocks';
import { WebFunctionCanary } from '../src/webFunctionCanary';

const resources = new Map<string, pulumi.runtime.MockResourceArgs>();
const mocks: pulumi.runtime.Mocks = {
  newResource(args) {
    resources.set(args.name, args);
    const state = { ...args.inputs };
    if (args.name.endsWith('-snapshot-job')) {
      state.outputs = {
        stableRevisionId: args.name.startsWith('bootstrap') ? '' : 'old',
        releaseTag: 'source-commit',
        functionArn: args.name.startsWith('bootstrap') ? '' : 'function-arn',
        productionEndpointArn: args.name.startsWith('bootstrap') ? '' : 'production-endpoint-arn',
      };
    } else if (
      ['-publish-stack', '-shift-stack', '-finalize-stack'].some((suffix) =>
        args.name.endsWith(suffix),
      )
    ) {
      state.outputs = {
        target: {
          candidateRevisionId: 'new',
          functionArn: 'function-arn',
          testUrl: 'https://test.example',
          productionUrl: 'https://prod.example',
          productionEndpointArn: 'production-endpoint-arn',
        },
      };
    } else if (args.name.endsWith('-observe-job')) {
      state.outputs = args.name.startsWith('rejected')
        ? { verdict: 'restore', reason: 'verification exited with 7' }
        : { verdict: 'promote', reason: '' };
    }
    return { id: args.name, state };
  },
  call(args) {
    return args.inputs;
  },
};

beforeEach(() => {
  resources.clear();
  pulumi.runtime.setMocks(mocks);
});

test.each([
  ['rejected', 0, 'restore'],
  ['accepted', 100, 'promote'],
  ['bootstrap', 100, 'promote'],
])(
  'rollout %s wires the verdict to the pinned traffic update before reporting the result',
  async (name, finalPercent, verdict) => {
    const registrations = jest.spyOn(MockMonitor.prototype, 'registerResource');
    const pipeline = new delivery.Pipeline(`${name}-pipeline`);
    const source = new delivery.GitHubSource(`${name}-source`, {
      repository: 'acme/dashboard',
      branch: 'main',
    });
    const canary = new WebFunctionCanary(name, {
      pipelineUrn: pipeline.urn,
      sourceUrn: source.urn,
      target: { stackName: 'acme/dashboard/dev' },
      awsEnvironment: 'acme/app/dev',
      verification: { command: 'npm test' },
      canaryPercent: 15,
    });
    const resultStage = await new Promise<string>((resolve) => {
      canary.completionStageUrn.apply(resolve);
    });
    await pulumi.runtime.disconnect();
    const bootstrap = name === 'bootstrap';
    const published = resources.get(`${name}-publish-stack`)!.inputs.stacks.target.config;
    expect(published['webFunctionCanary:releaseTag']).toBe('source-commit');
    expect(JSON.parse(published['webFunctionCanary:release']).candidatePercent).toBe(
      bootstrap ? 100 : 0,
    );
    const finalize = resources.get(`${name}-finalize-stack`)!.inputs.stacks.target.config;
    expect(JSON.parse(finalize['webFunctionCanary:release'])).toEqual({
      phase: 'finalize',
      stableRevisionId: bootstrap ? '' : 'old',
      candidateRevisionId: 'new',
      candidatePercent: finalPercent,
    });
    const shift = resources.get(`${name}-shift-stack`)!.inputs.stacks.target.config;
    expect(JSON.parse(shift['webFunctionCanary:release'])).toMatchObject({
      candidatePercent: 15,
      candidateRevisionId: 'new',
    });
    expect(resources.get(`${name}-observe-job`)!.inputs.environment).toMatchObject({
      CANARY_PHASE: 'canary',
      CANARY_BAKE_SECONDS: '300',
      CANARY_PRODUCTION_ENDPOINT_ARN: 'production-endpoint-arn',
    });
    expect(resources.get(`${name}-result-job`)!.inputs.environment.CANARY_VERDICT).toBe(verdict);
    const members = [...resources.values()].filter(({ type }) =>
      ['delivery:index:Stacks', 'delivery:index:Job'].includes(type),
    );
    expect(resultStage).toMatch(new RegExp(`${name}-canary$`));
    expect(
      [...resources.values()].filter(({ type }) => type === 'delivery:index:Stage'),
    ).toHaveLength(1);
    expect(members).toHaveLength(7);
    const stageUrns = await Promise.all(
      members.map(
        (member) => new Promise<string>((resolve) => member.inputs.stage.urn.apply(resolve)),
      ),
    );
    expect(stageUrns).toEqual(members.map(() => resultStage));
    const order = [
      'snapshot-job',
      'publish-stack',
      'verify-job',
      'shift-stack',
      'observe-job',
      'finalize-stack',
      'result-job',
    ];
    for (let i = 1; i < order.length; i++) {
      const request = registrations.mock.calls.find(
        ([registration]) => registration.getName() === `${name}-${order[i]}`,
      )?.[0];
      expect(request?.getDependenciesList()).toContainEqual(
        expect.stringMatching(new RegExp(`::${name}-${order[i - 1]}$`)),
      );
    }
  },
);
