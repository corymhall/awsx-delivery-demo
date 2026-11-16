import * as pulumi from '@pulumi/pulumi';

/**
 * Decode an ECS service identifier without reading mutable service state.
 *
 * @param arn Long-form ECS service ARN.
 * @returns Cluster ARN, service name and region encoded in the identifier.
 */
export function parseEcsServiceArn(arn: string): {
  clusterArn: string;
  serviceName: string;
  region: string;
} {
  const match =
    /^arn:(aws(?:-[a-z]+)*):ecs:([a-z0-9-]+):(\d{12}):service\/([A-Za-z0-9_-]{1,255})\/([A-Za-z0-9_-]{1,255})$/.exec(
      arn,
    );
  if (!match || match[0] !== arn) {
    throw new pulumi.InputPropertyError({
      propertyPath: 'serviceArn',
      reason:
        'Provide a long-form ECS service ARN from the completed infrastructure update, such as arn:aws:ecs:us-east-2:123456789012:service/cluster/app. Legacy short ARNs must be migrated to include the cluster name.',
    });
  }
  const [, partition, region, account, cluster, serviceName] = match;
  return {
    clusterArn: `arn:${partition}:ecs:${region}:${account}:cluster/${cluster}`,
    serviceName: serviceName!,
    region: region!,
  };
}

/**
 * Decode the explicitly authorized pipeline stack, independently of Delivery environment values.
 *
 * @param name Fully qualified organization/project/stack name.
 * @returns API coordinates for the pipeline stack.
 */
export function parsePipelineStack(name: string): {
  organization: string;
  project: string;
  stack: string;
} {
  const match = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/.exec(name);
  if (!match || match[0] !== name || name.startsWith('urn:')) {
    throw new pulumi.InputPropertyError({
      propertyPath: 'pipelineStack',
      reason:
        'Provide a fully qualified pipeline stack name, such as my-org/pipeline/dev, not a resource URN or an unqualified stack name.',
    });
  }
  return { organization: match[1]!, project: match[2]!, stack: match[3]! };
}
