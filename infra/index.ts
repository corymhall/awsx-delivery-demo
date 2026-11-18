import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import * as awsx from '@pulumi/awsx';
import * as aws from '@pulumi/aws';
import * as awsxDelivery from '@pulumi/awsx-delivery';
import * as ccapi from '@pulumi/aws-native';
import { checkpointConfig } from '../shared/checkpoint';
import { deployment } from '../shared/deployment';

const ccapiProvider = new ccapi.Provider('aws-native', {
  region: deployment.region,
  defaultTags: {
    tags: {
      'delivery:app': deployment.app.project,
      'delivery:environment': deployment.app.stack,
      owner: 'chall',
    },
  },
});

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

const task = new awsx.ecs.TaskDefinition(
  'task',
  {
    cpuArchitecture: awsx.ecs.CpuArchitecture.ARM64,
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

const organization = pulumi.getOrganization();
const identity = new pulumi.StackReference(
  `${organization}/${deployment.identity.project}/${deployment.identity.stack}`,
);
const teamName = identity.requireOutput('teamName');
const executionRoleArn = identity.requireOutput('executionRoleArn');
const hookLambda = new awsxDelivery.EcsDeliveryApprovalHook(
  'hook',
  {
    authentication: {
      teamOidc: { teamName },
    },
    pipelineStack: `${organization}/${deployment.pipeline.project}/${deployment.pipeline.stack}`,
    executionRoleArn,
    checkpoint: {
      stageName: checkpointConfig.stageName,
      completion: checkpointConfig.completion,
    },
    manualUpdates: awsxDelivery.ManualUpdateBehavior.BYPASS,
  },
  { provider },
);

const service = new awsx.ecs.Service(
  'service',
  {
    taskDefinitionArn: task.taskDefinitionArn,
    clusterArn: cluster.arn,
    vpcSubnetIds: vpc.privateSubnetIds,
    waitForSteadyState: false,
    deploymentStrategy: {
      canary: {
        canaryPercent: 10,
        canaryBakeTimeMinutes: 10,
        bakeTimeMinutes: 5,
        lambdaHooks: [
          {
            lifecycleStages: [awsx.ecs.ProgressiveLambdaLifecycleStage.POST_TEST_TRAFFIC_SHIFT],
            hookDetails: hookLambda.hookDetails,
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
          testTraffic: {
            match: {
              headers: [
                {
                  name: checkpointConfig.testHeaderName,
                  values: [checkpointConfig.testHeaderValue],
                },
              ],
            },
          },
        },
      },
    },
  },
  { providers },
);

export const ecsServiceArn = service.serviceArn;
export const ecsTaskDefinition = task.taskDefinitionArn;
export const testUrl = pulumi.interpolate`http://${alb.dnsName}`;
