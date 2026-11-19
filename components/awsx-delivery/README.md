# AWSX Delivery components

Experimental Pulumi components for ECS deployment checkpoints and Lambda Web Function canaries.

## Install

From a demo project such as `infra-web` or `pipeline`:

```sh
pulumi package add ../components/awsx-delivery
```

From another repository with access to this repo, pin a commit:

```sh
pulumi package add github.com/corymhall/awsx-delivery-demo.git/components/awsx-delivery@<commit>
```

Use `@pulumi/pulumi` 3.275.0 or newer. Pipeline projects that import `@pulumi/delivery` also need that SDK.

## ECS deployment checkpoint

Create the hook in the application stack:

```ts
import { EcsCheckpointCompletion, EcsDeliveryApprovalHook } from '@pulumi/awsx-delivery';

const hook = new EcsDeliveryApprovalHook('hook', {
  pipelineStack: 'my-org/pipeline/dev',
  authentication: { teamOidc: { teamName: 'delivery' } },
  checkpoint: { stageName: 'test', completion: EcsCheckpointCompletion.AUTOMATED_TEST },
});
```

Attach `hook.functionArn` and `hook.hookDetails` at `POST_TEST_TRAFFIC_SHIFT` and set `waitForSteadyState: false`. Add the matching checkpoint after the application update:

```ts
import { EcsDeploymentCheckpoint } from '@pulumi/awsx-delivery';

new EcsDeploymentCheckpoint('test', {
  pipelineUrn: pipeline.urn,
  upstreamStageUrn: dev.urn,
  sourceUrn: source.urn,
  serviceArn: appOutputs.ecsServiceArn,
  taskDefinitionArn: appOutputs.ecsTaskDefinition,
  environment: 'my-org/my-app/dev',
  automatedTest: {
    command: 'node --test infra/test/integration.test.ts',
    environment: {
      TEST_URL: appOutputs.testUrl,
      TEST_HEADER_NAME: 'X-Deployment-Test',
      TEST_HEADER_VALUE: 'green',
    },
  },
});
```

Full example: [application stack](../../infra/index.ts) and [pipeline](../../pipeline/index.ts).

## Lambda Web Function canary

Add a canary to an existing Delivery pipeline. The component creates three stages:

- **Deploy** snapshots production, publishes the candidate, and verifies it on the test endpoint.
- **Shift** rechecks the baseline, shifts traffic, and runs the canary probe. On probe failure or timeout it restores stable, confirms the live weights, and fails this stage before Promote can run.
- **Promote** moves all traffic to the candidate and confirms live routing. The component's `completionStageUrn` identifies this stage.

```ts
import { WebFunctionCanary } from '@pulumi/awsx-delivery';

new WebFunctionCanary('dashboard', {
  pipelineUrn: pipeline.urn,
  sourceUrn: source.urn,
  target: { stackName: 'my-org/web-app/dev', directory: 'infra-web' },
  awsEnvironment: 'my-org/my-app/dev',
  canaryPercent: 10,
  canaryBakeTimeMinutes: 5,
  requireApprovalBeforeShift: true, // Optional approval gate. Default: false.
  verification: { directory: 'pipeline-web', command: 'node scripts/probe.ts' },
});
```

In the application stack, wire the function's revision into both endpoints:

```ts
import { WebFunctionCanaryRouting } from '@pulumi/awsx-delivery';
import { WebFunctionAuthType, WebFunctionEndpoint } from '@pulumi/awsx-next';

const routing = new WebFunctionCanaryRouting('routing', {
  candidateRevisionId: app.revisionId,
});
// This public demo delegates authentication to the application.
const endpoint = {
  functionName: app.functionName,
  authType: WebFunctionAuthType.APPLICATION_MANAGED,
};
const test = new WebFunctionEndpoint('test', {
  ...endpoint,
  revisions: [{ revisionId: routing.candidateRevisionId }],
});
const production = new WebFunctionEndpoint('production', {
  ...endpoint,
  revisions: routing.productionRevisions,
});

export const candidateRevisionId = routing.candidateRevisionId;
export const functionArn = app.functionArn;
export const productionEndpointArn = production.endpointArn;
export const productionUrl = production.url;
export const testUrl = test.url;
```

The verification command receives `CANARY_CANDIDATE_URL` and `CANARY_PRODUCTION_URL`. Exit nonzero to reject the candidate.

The demo enables `requireApprovalBeforeShift` in `pipeline-web/index.ts`. Shift
requires one approval from anyone with approval permission on the pipeline. This
requires Delivery's Approvals feature. On first deploy, there is no stable revision.
Deploy still creates production at 100% candidate before the gate, and Shift
skips the split and bake.

Run only one release at a time per target. Delivery serializes each stage, not
the entire rollout. If a deployment is cancelled or loses its runner while
traffic is split, check live routing and restore the stable revision through
the application stack before starting another release.

Full example: [application stack](../../infra-web/index.ts), [pipeline](../../pipeline-web/index.ts), and [verification script](../../pipeline-web/scripts/probe.ts).

See [Contributing](../../CONTRIBUTING.md) for development and validation.
