# AWSX Delivery Demo

TODO:

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
