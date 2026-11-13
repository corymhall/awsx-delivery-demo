import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as pulumiservice from '@pulumi/pulumiservice';
import { deployment } from '../shared/deployment';

const organization = pulumi.getOrganization();
const provider = new aws.Provider('aws', {
  region: deployment.region,
  defaultTags: {
    tags: {
      'delivery:app': deployment.app.project,
      'delivery:environment': deployment.app.stack,
      owner: 'chall',
    },
  },
});

const team = new pulumiservice.Team('delivery-hooks', {
  organizationName: organization,
  name: 'awsx-delivery-demo-hooks',
  teamType: 'pulumi',
});
const teamName = team.name.apply((name) => {
  if (!name) throw new Error('Delivery hook team has no name');
  return name;
});

const role = new aws.iam.Role(
  'hook-execution',
  { assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }) },
  { provider },
);

// Account-wide outbound federation must already be enabled. Only look it up here.
const federation = aws.iam.getOutboundWebIdentityFederationOutput({ provider });
new pulumiservice.OidcIssuer(
  'delivery-hook-aws',
  {
    organization,
    name: 'awsx-delivery-demo-aws',
    url: federation.issuerIdentifier,
    maxExpirationSeconds: 900,
    policies: [
      {
        decision: pulumiservice.AuthPolicyDecision.Allow,
        tokenType: pulumiservice.AuthPolicyTokenType.Team,
        teamName,
        rules: { aud: `urn:pulumi:org:${organization}`, sub: role.arn },
      },
    ],
  },
  // Pulumi Cloud populates thumbprints automatically. Preserve them on refresh.
  { ignoreChanges: ['thumbprints'] },
);
new pulumiservice.TeamStackPermission('delivery-hook-pipeline', {
  organization,
  project: deployment.pipeline.project,
  stack: deployment.pipeline.stack,
  team: teamName,
  permission: pulumiservice.TeamStackPermissionScope.Edit,
});

export { teamName };
export const executionRoleArn = role.arn;
