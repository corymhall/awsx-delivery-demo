# AWSX Delivery components

Experimental source-based Pulumi components for ECS deployment checkpoints.
These APIs can change and are not part of the AWSX library.

## Add the package

From this repository's `infra` or `pipeline` directory, run:

```sh
pulumi package add ../components/awsx-delivery
```

Once the repository is public, use a Git commit containing the package:

```sh
pulumi package add github.com/corymhall/awsx-delivery-demo.git/components/awsx-delivery@<commit>
```

Pulumi generates a consumer SDK and resolves the Delivery dependency declared in
`PulumiPlugin.yaml`. A program that imports Delivery directly also needs its own
Delivery package dependency. The demo pipeline declares both packages.

The component runtime and consuming programs require `@pulumi/pulumi` 3.275.0 or
newer. Deployment requires access to the Delivery service and the matching provider.

## Add an ECS checkpoint

In the application program, create a hook for the pipeline's checkpoint stage:

```typescript
import * as awsxDelivery from '@pulumi/awsx-delivery';

const hook = new awsxDelivery.EcsDeliveryApprovalHook('hook', {
  pipelineStack: 'my-org/pipeline/dev',
  authentication: { teamOidc: { teamName: 'delivery' } },
  checkpoint: {
    stageName: 'test',
    completion: awsxDelivery.EcsCheckpointCompletion.AUTOMATED_TEST,
  },
});
```

Authorize the hook's execution identity before use. Attach `hook.functionArn` and
`hook.hookDetails` to the ECS service at `POST_TEST_TRAFFIC_SHIFT`. Set
`waitForSteadyState: false` so the application update can finish while ECS waits.

In the pipeline, create an `EcsDeploymentCheckpoint` named `test` with an
`automatedTest` command. Pass the pipeline, upstream stage, and source URNs, the
updated service and task definition ARNs, and an ESC environment for AWS credentials.
See the complete [application](../../infra/index.ts) and
[pipeline](../../pipeline/index.ts) programs for the paired configuration.

## Component reference

- [`EcsDeliveryApprovalHook`](src/ecsDeliveryApprovalHook.ts) creates the authenticated Lambda and renders the ECS hook payload. It does not configure the ECS service or federation trust.
- [`EcsDeploymentCheckpoint`](src/ecsDeploymentCheckpoint.ts) discovers the deployment, creates the approval or automated-test checkpoint, and verifies deployment completion. It does not own the pipeline or ECS service.
- [`PulumiApiHook`](src/pulumiApiHook.ts) creates the lower-level Lambda, log group, and execution policy. Its [Lambda reference](functions/pulumi-api-hook/README.md) describes the event contract and retries.

Source comments define inputs, outputs, and defaults. The resource-token namespace
is `awsx-delivery`.

See [Contributing](../../CONTRIBUTING.md) to build, test, or regenerate the package.
