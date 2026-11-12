# AWSX Delivery Demo

The pipeline deploys the ECS service with a blue/green strategy and runs application
integration tests before production traffic shifts. ECS signals the checkpoint at
`POST_TEST_TRAFFIC_SHIFT`. A Delivery Job runs `node:test` against a test rule on
the existing load balancer listener. The hook holds the deployment until the test
stage succeeds, then a separate Job verifies the ECS deployment.

`shared/checkpoint.json` configures the checkpoint and test routing for both Pulumi
programs. The test header selects a route, it is not authentication. This demo's
load balancer is public, so do not use this setup for sensitive test endpoints
without additional access controls. Manual updates explicitly bypass the Delivery
checkpoint.

To run the integration tests against an endpoint yourself, set `TEST_URL`,
`TEST_HEADER_NAME`, and `TEST_HEADER_VALUE`, then run
`node --test infra/test/integration.test.ts` with Node 24. The test route is available during a
progressive deployment.

## Development

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise trust
mise install
mise run hooks:install
mise run validate
```

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
