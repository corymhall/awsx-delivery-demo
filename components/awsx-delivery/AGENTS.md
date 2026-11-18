# AWSX Delivery components

Experimental source-based Pulumi package for this demo, separate from public AWSX.

- Export component classes explicitly from `index.ts`.
- Keep schema-compatible inputs and outputs and constructors shaped as `(name, args, opts?)`.
- Use `awsx-delivery` resource tokens.
- Keep `index.ts` CommonJS-compatible and unbundled for schema inference.
- Declare Pulumi package dependencies in `PulumiPlugin.yaml`. Do not vendor generated SDKs.
- The Lambda in `functions/pulumi-api-hook` has separate dependencies, tests, and a bundled artifact.
- Run `pulumi install` to generate package dependencies on a fresh checkout.
- Run `npm run check` for formatting, lint, types, tests, Lambda build, and schema inference.
- npm `prepare` installs and builds the Lambda.
