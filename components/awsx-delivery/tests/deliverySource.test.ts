import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { getDeliverySource } from '../src/deliverySource';

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource(args) {
    resources.push(args);
    return { id: args.name, state: { ...args.inputs, commit: 'test-commit' } };
  },
  call(args) {
    return args.inputs;
  },
});

/**
 * Await a resource property for assertions.
 *
 * @param value Output to resolve.
 * @returns Its resolved value.
 */
function resolve<T>(value: pulumi.Output<T>): Promise<T> {
  return new Promise((done) => {
    value.apply((result) => {
      done(result);
    });
  });
}

const parent = new pulumi.ComponentResource('example:index:Sources', 'sources');

test.each([
  ['github', delivery.GitHubSource],
  ['gitlab', delivery.GitLabSource],
  ['bitbucket', delivery.BitbucketSource],
  ['azure-devops', delivery.AzureDevOpsSource],
] as const)(
  'hydrates a parent-qualified %s source without creating a replacement',
  async (name, Source) => {
    const source = new Source(name, { repository: 'acme/app', branch: 'main' }, { parent });
    const urn = await resolve(source.urn);
    const reference = getDeliverySource(`${name}-reference`, urn);
    expect(await resolve(reference.urn)).toBe(urn);
    expect(resources.filter((resource) => resource.name === `${name}-reference`)).toEqual([]);
  },
);

test('hydrates a future source type without a source-specific SDK class', async () => {
  const source = new pulumi.ComponentResource(
    'delivery:index:FutureVCSSource',
    'future',
    {},
    { parent },
    true,
  );
  const urn = await resolve(source.urn);
  const reference = getDeliverySource('future-reference', urn);
  expect(await resolve(reference.urn)).toBe(urn);
  expect(resources.filter((resource) => resource.name === 'future-reference')).toEqual([]);
});

test.each([
  'https://github.com/acme/app',
  'urn:pulumi:dev::project::delivery:index:GitHubSource',
  'urn:pulumi:dev::::delivery:index:GitHubSource::source',
  'urn:pulumi:dev::project::delivery:index:GitHubSource::source::extra',
  'urn:pulumi:dev::project::::source',
  'urn:pulumi:dev::project::invalid-parent$delivery:index:GitHubSource::source',
])('rejects a malformed source URN: %s', (urn) => {
  expect(() => getDeliverySource('invalid-reference', urn)).toThrow(pulumi.InputPropertyError);
});
