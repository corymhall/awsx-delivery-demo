import * as pulumi from '@pulumi/pulumi';
import { WebFunctionCanaryRouting } from '../src/webFunctionCanaryRouting';

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args) => ({ id: args.name, state: args.inputs }),
    call: (args) => args.inputs,
  });
});

const cases = [
  {
    phase: 'publish',
    stableRevisionId: '',
    candidatePercent: 100,
    expected: [{ revisionId: 'next', weight: 100 }],
  },
  {
    phase: 'publish',
    stableRevisionId: 'stable',
    candidatePercent: 0,
    expected: [{ revisionId: 'stable', weight: 100 }],
  },
  {
    phase: 'shift',
    stableRevisionId: 'stable',
    candidateRevisionId: 'next',
    candidatePercent: 15,
    expected: [
      { revisionId: 'stable', weight: 85 },
      { revisionId: 'next', weight: 15 },
    ],
  },
  {
    phase: 'reconcile',
    stableRevisionId: 'stable',
    candidateRevisionId: 'next',
    candidatePercent: 15,
    expected: [
      { revisionId: 'stable', weight: 85 },
      { revisionId: 'next', weight: 15 },
    ],
  },
  {
    phase: 'reconcile',
    stableRevisionId: 'stable',
    candidateRevisionId: 'next',
    candidatePercent: 0,
    expected: [{ revisionId: 'stable', weight: 100 }],
  },
];

test.each(cases)(
  '$phase at $candidatePercent% computes weights without AWS resources',
  async ({ expected, ...release }) => {
    pulumi.runtime.setConfig('webFunctionCanary:release', JSON.stringify(release));
    const routing = new WebFunctionCanaryRouting('routing', {
      candidateRevisionId: pulumi.output('next'),
    });
    const revisions = await new Promise<typeof expected>((resolve) => {
      routing.productionRevisions.apply(resolve);
    });
    await pulumi.runtime.disconnect();
    expect(revisions).toEqual(expected);
  },
);
