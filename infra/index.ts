import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import * as pulumiservice from '@pulumi/pulumiservice';
import * as awsx from '@pulumi/awsx';
import * as aws from '@pulumi/aws';
import * as awsxNext from '@pulumi/awsx-next';
import * as privateAwsxNext from '@pulumi/awsx-next-private';
import * as ccapi from '@pulumi/aws-native';

const ccapiProvider = new ccapi.Provider('aws-native', {
  region: 'us-east-2',
  defaultTags: {
    tags: {
      'delivery:app': 'awsx-delivery-demo',
      'delivery:environment': 'dev',
      owner: 'chall',
    },
  },
});

const provider = new aws.Provider('aws', {
  region: 'us-east-2',
  defaultTags: {
    tags: {
      'delivery:app': 'awsx-delivery-demo',
      'delivery:environment': 'dev',
      owner: 'chall',
    },
  },
});

const providers = [provider, ccapiProvider];

const vpc = new awsx.ec2.Vpc(
  'vpc',
  {
    subnetStrategy: awsx.ec2.SubnetAllocationStrategy.AutoMerge,
    natGateways: { strategy: awsx.ec2.NatGatewayStrategy.Single },
    subnetSpecs: [{ type: awsx.ec2.SubnetType.Private }, { type: awsx.ec2.SubnetType.Public }],
  },
  { provider },
);

const repository = new awsx.ecr.Repository(
  'repository',
  {
    forceDelete: true,
  },
  { provider },
);
const image = new awsx.ecr.Image(
  'image',
  {
    repositoryUrl: repository.url,
    context: path.join(__dirname, 'app'),
    platform: 'linux/arm64',
  },
  { provider },
);

const task = new awsxNext.TaskDefinition(
  'task',
  {
    cpuArchitecture: awsxNext.CpuArchitecture.ARM64,
    containers: {
      app: {
        image: image.imageUri,
        portMappings: [
          {
            containerPort: 3000,
          },
        ],
      },
    },
  },
  { providers },
);

// The caller owns frontend networking; the service manages only task-side ingress.
// Use standalone rules, not inline SecurityGroup.ingress/egress.
const frontendGroup = new aws.ec2.SecurityGroup('frontend', { vpcId: vpc.vpcId }, { provider });
const port = 80;
new aws.vpc.SecurityGroupIngressRule(
  'frontend-ipv4',
  {
    securityGroupId: frontendGroup.id,
    ipProtocol: 'tcp',
    fromPort: port,
    toPort: port,
    cidrIpv4: '0.0.0.0/0',
  },
  { provider },
);
new aws.vpc.SecurityGroupEgressRule(
  'frontend-egress',
  {
    securityGroupId: frontendGroup.id,
    ipProtocol: '-1',
    cidrIpv4: '0.0.0.0/0',
  },
  { provider },
);

const alb = new aws.lb.LoadBalancer(
  'alb',
  {
    loadBalancerType: 'application',
    securityGroups: [frontendGroup.id],
    subnets: vpc.publicSubnetIds,
  },
  { provider },
);
// The caller owns the listener and its default response. The service adds forwarding rules.
const listener = new aws.lb.Listener(
  'listener',
  {
    loadBalancerArn: alb.arn,
    port,
    protocol: 'HTTP',
    defaultActions: [
      {
        type: 'fixed-response',
        fixedResponse: {
          statusCode: '404',
          contentType: 'text/plain',
          messageBody: 'Not found\n',
        },
      },
    ],
  },
  { provider },
);

const cluster = new aws.ecs.Cluster('cluster', {}, { provider });

const deliveryRun = process.env.DELIVERY_RUN;
// Partial Delivery identity is a configuration error, never a manual bypass.
const isDeliveryRun = process.env.DELIVERY_PIPELINE !== undefined || deliveryRun !== undefined;

if (isDeliveryRun && (!deliveryRun || !/^[1-9][0-9]*$/.test(deliveryRun))) {
  throw new Error('Delivery requires a positive integer DELIVERY_RUN');
}
const organization = pulumi.getOrganization();
const pipelineProject = 'awsx-delivery-demo-pipeline';
const pipelineStack = 'dev';
const team = new pulumiservice.Team('delivery-hooks', {
  organizationName: organization,
  name: 'awsx-delivery-demo-hooks',
  teamType: 'pulumi',
});
const teamName = team.name.apply((name) => {
  if (!name) throw new Error('Delivery hook team has no name');
  return name;
});
const hookLambda = new privateAwsxNext.PulumiApiHook(
  'hook',
  {
    authentication: {
      teamOidc: { teamName },
    },
    organization,
  },
  { provider },
);

// Account-wide outbound federation must already be enabled. Only look it up here.
const federation = aws.iam.getOutboundWebIdentityFederationOutput({ provider });
new pulumiservice.OidcIssuer('delivery-hook-aws', {
  organization,
  name: 'awsx-delivery-demo-aws',
  url: federation.issuerIdentifier,
  maxExpirationSeconds: 900,
  policies: [
    {
      decision: pulumiservice.AuthPolicyDecision.Allow,
      tokenType: pulumiservice.AuthPolicyTokenType.Team,
      teamName,
      rules: {
        aud: `urn:pulumi:org:${organization}`,
        sub: hookLambda.executionRoleArn,
      },
    },
  ],
});
new pulumiservice.TeamStackPermission('delivery-hook-pipeline', {
  organization,
  project: pipelineProject,
  stack: pipelineStack,
  team: teamName,
  permission: pulumiservice.TeamStackPermissionScope.Edit,
});

const service = new awsxNext.Service(
  'service',
  {
    taskDefinitionArn: task.taskDefinitionArn,
    clusterArn: cluster.arn,
    vpcSubnetIds: vpc.privateSubnetIds,
    deploymentStrategy: {
      blueGreen: {
        bakeTimeMinutes: 2,
        lambdaHooks: [
          {
            lifecycleStages: [awsxNext.ProgressiveLambdaLifecycleStage.POST_TEST_TRAFFIC_SHIFT],
            hookDetails: isDeliveryRun
              ? {
                  mode: 'delivery',
                  call: {
                    service: 'Delivery',
                    action: 'ContinueManualGate',
                    waitForApproval: true,
                    parameters: {
                      organization,
                      project: pipelineProject,
                      stack: pipelineStack,
                      stage: 'checkpoint',
                    },
                    request: {
                      runNumber: deliveryRun,
                      condition: 'pause-hook',
                    },
                  },
                }
              : { mode: 'manual' },
            functionArn: hookLambda.functionArn,
          },
        ],
      },
    },
    loadBalancerAttachments: {
      app: {
        application: {
          containerName: 'app',
          containerPort: 3000,
          targetHealthCheck: { path: '/health' },
          listenerArn: listener.arn,
          priority: 50,
        },
      },
    },
  },
  {
    providers: [provider, ccapiProvider],
    // Delivery runs delegate deployment health to the checkpoint Job.
    transforms: [
      (args) =>
        args.type === 'aws:ecs/service:Service'
          ? {
              props: { ...args.props, waitForSteadyState: !isDeliveryRun },
              opts: args.opts,
            }
          : undefined,
    ],
  },
);

export const ecsCluster = cluster.arn;
export const ecsService = service.serviceName;
