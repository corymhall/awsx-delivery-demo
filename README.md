# AWSX Delivery demo

Deploy an Amazon ECS service with a canary strategy and test the new revision
before it receives production traffic. Pulumi Delivery runs the tests while an
ECS lifecycle hook holds the deployment, then verifies that the deployment completes.

Blog walkthrough: **link pending publication**.

The ECS service and task definition use the published AWSX v3.14.0 package.
The experimental Delivery hook and checkpoint are local components and are not
part of the AWSX library. The demo creates billable AWS resources.
Its load balancer is public. The test header selects a route, not an authenticated
endpoint. Do not expose sensitive test behavior without additional access controls.
Direct updates outside Delivery explicitly bypass the test checkpoint.

## Repository layout

- `identity/` defines the hook's identity and permissions.
- `infra/` defines the application, load balancer, and ECS service.
- `pipeline/` defines the Delivery pipeline and integration-test checkpoint.
- `shared/` holds deployment identifiers and checkpoint settings.
- [`components/awsx-delivery/`](components/awsx-delivery/README.md) contains the reusable preview components.

See [Contributing](CONTRIBUTING.md) for local setup and checks.
