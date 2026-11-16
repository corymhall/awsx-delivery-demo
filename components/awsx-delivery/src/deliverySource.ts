import * as pulumi from '@pulumi/pulumi';

/**
 * Hydrate a source as a generic resource reference. Delivery validates source eligibility.
 *
 * @param name Local reference name. Does not create a source.
 * @param urn Existing source URN, including any parent type qualification.
 * @returns A reference carrying the original resource URN, without a source-specific SDK class.
 */
export function getDeliverySource(name: string, urn: string): pulumi.ComponentResource {
  const parts = urn.split('::');
  const types = parts[2]?.split('$');
  if (
    parts.length !== 4 ||
    !/^urn:pulumi:[^:]+$/.test(parts[0]!) ||
    !parts[1] ||
    !parts[3] ||
    !types?.every((type) => /^[^:$]+:[^:$]*:[^:$]+$/.test(type))
  ) {
    throw new pulumi.InputPropertyError({
      propertyPath: 'sourceUrn',
      reason: `Expected a Pulumi resource URN, not a repository URL or name. Received: ${urn}`,
    });
  }
  // A parented resource encodes ParentType$ChildType. The final type identifies the source.
  return new pulumi.ComponentResource(types[types.length - 1]!, name, {}, { urn });
}
