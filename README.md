# AWSX Delivery Demo

The `dev` stage deploys `infra/`, including the hook Lambda, Pulumi team, OIDC
trust, and pipeline-stack permission. The `checkpoint` stage follows with approval
and verification.

Before the first run, create the infra and pipeline target stacks and attach their
ESC environments. The infra deployment identity needs permission to manage the
Pulumi team, OIDC issuer, and team stack permission as well as the AWS resources.

AWS outbound identity federation must already be enabled for the target account.
Infra looks up its issuer URL with
`aws.iam.getOutboundWebIdentityFederationOutput`, which requires
`iam:GetOutboundWebIdentityFederationInfo`. It does not manage the account-wide
feature. If the issuer is already registered in the Pulumi organization, reuse or
import that registration rather than creating a conflicting one.

The hook targets `awsx-delivery-demo-pipeline/main` in the infra stack's
organization. No pipeline identity config is required.
With neither Delivery identity variable present, local updates send
`hookDetails: { mode: 'manual' }`. The Lambda succeeds without authenticating or
contacting Delivery, and the update waits for ECS steady state. Partial or invalid
Delivery identity fails instead of bypassing approval. Delivery updates use
`mode: 'delivery'` and keep the existing approval flow.

The pinned private component revision includes the Lambda's manual bypass.
The initial infra deployment can run locally with the hook attached.

ECS receives the hook ARN only after the Lambda, issuer trust, and team stack
permission have been created.

## Development

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise trust
mise install
mise run hooks:install
mise run validate
```

Mise pins Node.js and hk. Its npm dependency provider automatically runs
`npm ci` in `infra/` before tasks when the package manifests change or
`node_modules/` is missing. Commit both `mise.lock` and
`infra/package-lock.json`.

Commands run from the repository root:

- `mise run format` formats infrastructure files.
- `mise run format:check` checks formatting without changing files.
- `mise run lint` runs Oxlint.
- `mise run typecheck` checks TypeScript.
- `mise run validate` runs all checks, including hk configuration validation.
- `mise deps` explicitly installs stale npm dependencies.

Git pre-commit and pre-push hooks run the same non-mutating validation.
Hook installation is local to this checkout unless hk is already installed
globally, in which case hk reuses the existing global hooks.
No task or hook runs Pulumi operations.

## ECS deployment verification

After updating infra, the `dev` stage runs `discover-deployment`. It finds the
run's exact ECS deployment before `checkpoint` can open its gate. The checkpoint
stage is always declared. Its `when` input resolves to the approval and manual
rules when a deployment exists, or `undefined` for a verified no-op. This is an
experiment in resolving a previously unknown gate input to no gate.

For a deployment, `checkpoint` waits for ECS to reach its Lambda hook and for
human approval, then `verify-deployment` waits for the discovered ARN. This
expects the API hook to use `waitForApproval: true`, without a separate ECS pause
hook or continuation Job. For a no-op, verification logs that there is nothing
to approve or wait for.

The infra stack exports `ecsCluster`, `ecsService`, and `ecsTaskDefinition`.
Discovery uses these outputs and matches the hook's `checkpoint` stage, even
though the discovery Job itself runs in `dev`.

Both AWS Jobs run through `pulumi env run awsx-delivery-demo/dev` to obtain AWS
credentials. They use region `us-east-2`. The runner must be authenticated to
Pulumi and authorized to open that ESC environment.

The Job runner needs Bash, AWS CLI v2 with service-deployment support, and `jq`.
Its AWS identity needs `ecs:ListServiceDeployments`,
`ecs:DescribeServiceDeployments`, `ecs:DescribeServices`, and
`ecs:DescribeServiceRevisions` for the target service, revisions, and deployments.

The ECS Lambda hook's `hookDetails.call` must contain:

- `service: 'Delivery'` and `action: 'ContinueManualGate'`.
- `parameters.organization`, `parameters.project`, and `parameters.stack`
  identifying the pipeline stack, not the app stack.
- `parameters.stage: 'checkpoint'`.
- `request.runNumber: process.env.DELIVERY_RUN` and `request.condition: 'pause-hook'`.
- `waitForApproval: true`.

`pipeline/scripts/find-ecs-deployment.sh` examines all pages of deployment history,
including completed, stopped, and rolled-back deployments. It matches the pipeline,
run, and stage in the configured Lambda hook details. Multiple matches fail.
With `--allow-no-deployment`, zero matches count as a no-op only when there are
no active deployments, the latest deployment succeeded with the expected task
definition, and the service has the expected task definition, current run's hook
configuration, no pending tasks, and its desired running task count. Discovery
requires three no-op observations spaced 10 seconds apart. Errors and ambiguous
states fail rather than bypassing approval. These are observational checks, not
an atomic record of what the infra update did.

The chosen ARN is passed to `wait-for-ecs-deployment.sh`, which polls every 15
seconds for up to 30 minutes and fails on rollback, stopped or missing deployments,
AWS errors, or timeout.

Run the offline discovery checks with:

```sh
python3 pipeline/scripts/test_discovery.py
```

During Delivery runs, the app update returns without waiting for ECS steady state
so the downstream approval gate can open. Manual updates wait for steady state.
