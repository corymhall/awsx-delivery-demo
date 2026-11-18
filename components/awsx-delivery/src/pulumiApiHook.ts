import * as path from 'node:path';
import * as fs from 'node:fs';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

/**
 * Preview OIDC authentication using an existing Pulumi team.
 */
export interface TeamOidcAuthentication {
  /**
   * Name of the existing team authorized to continue the pipeline's manual gates.
   */
  teamName: pulumi.Input<string>;
}

/**
 * Authentication for the API hook. Federation trust is managed separately.
 */
export interface ApiHookAuthentication {
  /**
   * Preview team-token authentication.
   */
  teamOidc: TeamOidcAuthentication;
}

/**
 * Settings for an authenticated ECS lifecycle-hook Lambda.
 */
export interface PulumiApiHookArgs {
  /**
   * Pulumi organization used for token exchange and call validation.
   */
  organization: pulumi.Input<string>;
  /**
   * Existing identity used by the function. Does not create federation trust or grants.
   */
  authentication: ApiHookAuthentication;
  /**
   * Pulumi API base URL. Default: https://api.pulumi.com.
   */
  apiUrl?: pulumi.Input<string>;
  /**
   * Lambda timeout in seconds. Default: 120.
   */
  timeoutSeconds?: pulumi.Input<number>;
  /**
   * Existing Lambda execution role ARN. The caller manages its Lambda trust policy. The component
   * attaches an inline policy for log writes and organization-scoped sts:GetWebIdentityToken, and
   * removes that policy when the component is deleted. Default: create a scoped execution role.
   */
  executionRoleArn?: pulumi.Input<string>;
  /**
   * Lambda memory in MiB. Default: 256.
   */
  memorySizeMiB?: pulumi.Input<number>;
}

/**
 * An authenticated Lambda for Pulumi API calls supplied through ECS hookDetails. Creates a
 * function, log group, and an execution role unless one is supplied. OIDC issuer trust, team
 * membership, and Delivery permissions must exist before invocation.
 */
export class PulumiApiHook extends pulumi.ComponentResource {
  /**
   * Function ARN to pass to an ECS lifecycle hook.
   */
  public readonly functionArn: pulumi.Output<string>;
  /**
   * Execution role ARN to use when configuring OIDC trust.
   */
  public readonly executionRoleArn: pulumi.Output<string>;

  constructor(name: string, args: PulumiApiHookArgs, opts?: pulumi.ComponentResourceOptions) {
    super('awsx-delivery:index:PulumiApiHook', name, {}, opts);

    const bundlePath = path.join(__dirname, '../functions/pulumi-api-hook/dist/index.js');
    if (!fs.existsSync(bundlePath)) {
      throw new Error(
        'Lambda bundle is missing. Run npm run build:function in components/awsx-delivery.',
      );
    }

    const logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {}, { parent: this });
    const role =
      args.executionRoleArn === undefined
        ? new aws.iam.Role(
            `${name}-execution`,
            {
              assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                Service: 'lambda.amazonaws.com',
              }),
            },
            { parent: this },
          )
        : undefined;
    const roleName = role
      ? role.name
      : pulumi.output(args.executionRoleArn!).apply((arn) => {
          const match =
            /^arn:[^:]+:iam::\d{12}:role\/(?:[\x21-\x7e]+\/)?([A-Za-z0-9_+=,.@-]{1,64})$/.exec(arn);
          if (!match) {
            throw new pulumi.InputPropertyError({
              propertyPath: 'executionRoleArn',
              reason: 'Provide an IAM role ARN.',
            });
          }
          return match[1]!;
        });
    const policy = new aws.iam.RolePolicy(
      `${name}-execution`,
      {
        role: roleName,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: pulumi.interpolate`${logGroup.arn}:*`,
            },
            {
              Effect: 'Allow',
              Action: 'sts:GetWebIdentityToken',
              Resource: '*',
              Condition: {
                'ForAllValues:StringEquals': {
                  'sts:IdentityTokenAudience': [
                    pulumi.interpolate`urn:pulumi:org:${args.organization}`,
                  ],
                },
                NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
              },
            },
          ],
        }),
      },
      { parent: this },
    );

    const executionRoleArn = args.executionRoleArn ?? role!.arn;
    const fn = new aws.lambda.Function(
      name,
      {
        role: executionRoleArn,
        runtime: aws.lambda.Runtime.NodeJS24dX,
        handler: 'index.handler',
        timeout: args.timeoutSeconds ?? 120,
        memorySize: args.memorySizeMiB ?? 256,
        code: new pulumi.asset.AssetArchive({ 'index.js': new pulumi.asset.FileAsset(bundlePath) }),
        loggingConfig: { logFormat: 'JSON', logGroup: logGroup.name },
        environment: {
          variables: {
            PULUMI_ORGANIZATION: args.organization,
            PULUMI_TEAM: args.authentication.teamOidc.teamName,
            PULUMI_API_URL: args.apiUrl ?? 'https://api.pulumi.com',
          },
        },
      },
      { parent: this, dependsOn: [policy] },
    );

    this.functionArn = fn.arn;
    this.executionRoleArn = pulumi.output(executionRoleArn);
    this.registerOutputs({
      functionArn: this.functionArn,
      executionRoleArn: this.executionRoleArn,
    });
  }
}
