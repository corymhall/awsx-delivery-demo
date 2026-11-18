# Contribute to the demo

## Install dependencies

Install [mise](https://mise.jdx.dev/) and run these commands from the repository root.
The pipeline and local component package use the published `@pulumi/delivery` SDK.

```sh
mise trust
mise install
pulumi install --cwd components/awsx-delivery
pulumi install --cwd infra
pulumi install --cwd pipeline
npm ci --prefix identity
mise run hooks:install
mise run validate
```

`pulumi install` generates the SDKs declared in each project's package manifest.
Its npm `prepare` script installs and builds the standalone Lambda.

These commands install dependencies and run checks. They do not deploy the demo.

## Check changes

Run all checks from the repository root:

```sh
mise run validate
```

Validation checks formatting, lint, and types for the Pulumi programs. It also runs
the component and Lambda tests, builds the Lambda, checks source-plugin schema
inference, and validates the Git hook configuration.

To format the application infrastructure, run `mise run format`. To format the
pipeline or component package, run the corresponding command:

```sh
npm --prefix pipeline run format
npm --prefix components/awsx-delivery run format
```

Git pre-commit and pre-push hooks run validation. The Pulumi programs use
`tsconfig.pulumi.json` to transpile without typechecking, so run validation before
pushing changes. Schema checks load the component plugin but do not deploy resources.

## Regenerate a consumer SDK

After changing a component's public inputs or outputs, regenerate both consumer SDKs:

```sh
pulumi package add ../components/awsx-delivery --cwd infra
pulumi package add ../components/awsx-delivery --cwd pipeline
mise run validate
```

For component-only checks, run `npm --prefix components/awsx-delivery run check`.
Do not commit generated SDKs, installed dependencies, or Lambda build output.

## Update demo settings

Edit `shared/deployment.ts` for repository, Region, stack, and ESC environment
settings. Keep project names consistent with each project's `Pulumi.yaml`.
Edit `shared/checkpoint.ts` for checkpoint and test-route settings shared by the
application and pipeline. Update both consumers together when those settings change.

Deploy the identity stack before the application stack. The application reads the
identity stack's outputs and attaches an inline policy to the hook's execution role.
The application update identity needs permission for both operations.

## Register the Delivery pipeline

With a Pulumi CLI that supports Delivery, run
`pulumi delivery register --cwd pipeline --stack dev` from a clean checkout of a
commit pushed to the tracked branch. Delivery reads the pipeline program location
from `delivery:source` in the pipeline stack config. Registration writes this setting
if it is missing. Commit the updated stack config after registration.

## Run the integration test against a deployment

The test route reaches the new revision during a progressive deployment. With
Node.js 24, set `TEST_URL`, `TEST_HEADER_NAME`, and `TEST_HEADER_VALUE` to the
endpoint and header values for that deployment, then run:

```sh
node --test infra/test/integration.test.ts
```
