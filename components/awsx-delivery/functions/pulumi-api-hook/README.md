# Pulumi API hook reference

The ECS lifecycle-hook Lambda implements `Delivery.ContinueManualGate` through the
preview HTTP API. This operation is an internal adapter, not a Cloud SDK method.
The component package builds and deploys the Lambda with Node.js 24 and handler
`index.handler`. See [Contributing](../../../../CONTRIBUTING.md) for build and test commands.

## Authentication

Delivery mode uses these Lambda environment variables:

- `PULUMI_ORGANIZATION` identifies the authorized organization.
- `PULUMI_TEAM` identifies the team used for authentication.
- `PULUMI_API_URL` defaults to `https://api.pulumi.com`.

The execution role needs CloudWatch Logs access and `sts:GetWebIdentityToken` for
the organization's audience. Pulumi's AWS OIDC issuer must trust the role. The team
needs read and write access to the pipeline stack. The Lambda needs network access
to STS and the Pulumi API, but no ECS permissions.

Team tokens are a preview workaround. `src/authentication.ts` implements authentication.
The event cannot select the backend or authentication identity. Its organization
must match `PULUMI_ORGANIZATION`.

## Event contract

ECS supplies the payload in `hookDetails`. The component renders this payload for
each deployment. The following example represents an automated-test checkpoint:

```typescript
{
	mode: 'delivery',
	call: {
		service: 'Delivery',
		action: 'ContinueManualGate',
		waitForApproval: true,
		waitForStage: true,
		parameters: {
			organization: 'my-org',
			project: 'pipeline',
			stack: 'dev',
			stage: 'test',
		},
		request: {
			runNumber: process.env.DELIVERY_RUN,
			condition: 'ecs-arrival',
		},
	},
}
```

`request.runNumber` is a positive integer string supplied by Delivery.
`request.condition` identifies a manual condition on the target stage's gate.
The hook satisfies that condition to signal ECS arrival. The condition can also
be combined with a human approval rule.

The Lambda reads the run at
`GET /api/preview/stacks/{organization}/{project}/{stack}/delivery/runs/{runNumber}`
and continues the matching gate at `POST .../gates/{gateId}/continue` with the
condition name. The former `Delivery.SignalStage` operation is unsupported.

### Completion settings

Both settings belong to `call` and default to `false`. Neither is forwarded to
the Delivery API.

| Settings | Success condition |
| --- | --- |
| Both omitted or `false` | Delivery accepts the continuation, or the named condition is already satisfied. |
| `waitForApproval: true` | The whole gate passes, including any human approval rules. Stage Jobs need not finish. |
| Both `true` | The gate passes and the checkpoint stage reports `succeeded`, including its test Jobs. |

`waitForStage: true` requires `waitForApproval: true`. Invalid combinations return
`FAILED`. `EcsDeliveryApprovalHook` sets both flags for `AUTOMATED_TEST` completion.
For `APPROVAL` completion, it sets only `waitForApproval`.

While waiting, the function returns `IN_PROGRESS` and ECS invokes it again.
A failed test stage returns `FAILED` rather than releasing the deployment.
The pipeline's later verification Job checks the final ECS deployment status.

Notify-only mode stops observing Delivery after the continuation succeeds. Any
separate ECS pause hook remains independent and needs its own continuation and
timeout handling. The demo uses the Lambda to hold ECS and has no separate pause hook.

### Manual mode

The payload `{ mode: 'manual' }` returns `SUCCEEDED` immediately and emits a
`ManualBypass` metric. It requires no Delivery identity or Lambda environment
configuration and makes no STS or Pulumi API calls.

Manual mode rejects a `call` field, including `call: null`. It intentionally
bypasses the checkpoint. Missing or malformed Delivery identity never selects
manual mode automatically.

Omitting `mode` retains Delivery behavior for existing consumers. Unsupported
modes, `mode: null`, and malformed calls return `FAILED`.

## Results and retries

The Lambda returns one of these statuses:

- `SUCCEEDED` when the selected completion condition is met.
- `IN_PROGRESS` while the gate or stage is pending, or after a retryable error.
- `FAILED` after invalid configuration, a terminal failure, or an exhausted retry budget.

Retries have a 30-second callback delay and a 30-minute budget from the first
retry. Returned `hookDetails` preserve the call and `retryState.startedAt`.
The budget includes gate readiness, human approval, and test-stage completion.

Network errors, HTTP 429 and server errors, and retryable STS failures return
`IN_PROGRESS`. A continuation conflict causes one reread. The conflict is accepted
only if the same gate's named manual condition is now satisfied. Completion
settings still apply after that reread.

Rejected conditions, canceled or superseded runs, authorization errors, missing
conditions, and closed gates without a recorded pass return `FAILED`. A run
without a gate yet returns `IN_PROGRESS` while the run remains active.

[ECS rolls back when a lifecycle hook returns `FAILED`](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/lambda-lifecycle-hooks.html).
The Lambda does not request rollback through the ECS API. An ECS hook timeout
configured for rollback also covers failures to invoke the Lambda.

Logs contain outcomes and HTTP statuses, never events, tokens, or response bodies.
Metrics count successes, retries, failures, and manual bypasses.
