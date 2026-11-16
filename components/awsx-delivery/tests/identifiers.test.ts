import * as pulumi from '@pulumi/pulumi';
import { parseEcsServiceArn, parsePipelineStack } from '../src/identifiers';

// These identifiers must remain unambiguous without querying current AWS state.
test.each([
  'arn:aws:ecs:us-east-2:123456789012:service/app',
  'arn:aws:ecs:us-east-2:123456789012:service/cluster/app/extra',
  'arn:aws:ecs:us-east-2:123:service/cluster/app',
  'arn:aws:lambda:us-east-2:123456789012:service/cluster/app',
  'app',
  'arn:aws:ecs:us-east-2:123456789012:service/cluster/app\n',
])('rejects an incomplete or non-service identifier: %s', (arn) => {
  expect(() => parseEcsServiceArn(arn)).toThrow(pulumi.InputPropertyError);
});

test.each([
  ['aws', 'us-east-2'],
  ['aws-us-gov', 'us-gov-west-1'],
  ['aws-cn', 'cn-north-1'],
])('preserves the %s partition and account when deriving the cluster', (partition, region) => {
  expect(
    parseEcsServiceArn(`arn:${partition}:ecs:${region}:123456789012:service/my-cluster/my-app`),
  ).toEqual({
    clusterArn: `arn:${partition}:ecs:${region}:123456789012:cluster/my-cluster`,
    serviceName: 'my-app',
    region,
  });
});

test.each([
  'dev',
  'project/dev',
  '/project/dev',
  'acme//dev',
  'acme/project/dev/extra',
  'acme/project/dev ',
  'acme/project/dev\n',
  'urn:pulumi:dev::project::delivery:index:Pipeline::pipeline',
])('rejects an ambiguous pipeline stack identity: %s', (name) => {
  expect(() => parsePipelineStack(name)).toThrow(pulumi.InputPropertyError);
});
