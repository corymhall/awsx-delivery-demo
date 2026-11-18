import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { getDeliverySource } from './deliverySource';
import { defaultEcsArrivalConditionName } from './ecsCheckpointDefaults';
import { parseEcsServiceArn } from './identifiers';

/**
 * Human approval settings.
 */
export interface EcsCheckpointApproval {
  /**
   * Eligible users or teams. Default: anyone with organization update permission.
   */
  approvers?: pulumi.Input<pulumi.Input<string>[]>;
  /**
   * Number of approvals. Default: one. Eligible run initiators may approve.
   */
  count?: pulumi.Input<number>;
}

/**
 * Settings for an application test Job run while ECS waits.
 */
export interface EcsCheckpointAutomatedTest {
  /**
   * Command to run from the source checkout.
   */
  command: pulumi.Input<string>;
  /**
   * Directory relative to the source root. Default: repository root, '.'.
   */
  directory?: pulumi.Input<string>;
  /**
   * Environment variables supplied to the test Job.
   */
  environment?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * Inputs for a checkpoint following an infrastructure update.
 */
export interface EcsDeploymentCheckpointArgs {
  /**
   * Existing pipeline resource URN.
   */
  pipelineUrn: pulumi.Input<string>;
  /**
   * Stage containing the infrastructure update.
   */
  upstreamStageUrn: pulumi.Input<string>;
  /**
   * Existing Delivery VCS source URN. Hydrated as a generic resource reference; the installed
   * Delivery provider validates which source types it supports.
   */
  sourceUrn: pulumi.Input<string>;
  /**
   * Named manual condition continued when ECS reaches test traffic. Must match the hook's
   * checkpoint.conditionName when customized. Default: ecs-arrival. The stage name comes from this
   * component's constructor name.
   */
  conditionName?: pulumi.Input<string>;
  /**
   * Long-form ECS service ARN from the completed infrastructure update. Encodes the cluster,
   * service and region. Legacy short ARNs must be migrated to include the cluster name.
   */
  serviceArn: pulumi.Input<string>;
  /**
   * Expected task definition ARN from the infrastructure update.
   */
  taskDefinitionArn: pulumi.Input<string>;
  /**
   * ESC environment providing AWS credentials.
   */
  environment: pulumi.Input<string>;
  /**
   * Default: one approval from anyone with organization update permission.
   */
  approval?: EcsCheckpointApproval;
  /**
   * Run this test instead of requiring human approval. Must match the hook completion mode.
   */
  automatedTest?: EcsCheckpointAutomatedTest;
  /**
   * Deployment polling timeout in seconds. Default: 1800.
   */
  timeoutSeconds?: pulumi.Input<number>;
}

interface CheckpointResources {
  stageUrn?: string;
  verificationJobUrn?: string;
  continuationStageUrn: string;
}

/**
 * Discovers this run's ECS deployment, waits for ECS arrival and approval or automated tests, and
 * verifies success. Only a verified no-op bypasses the gate. Owns Jobs and Stages, not the
 * pipeline, source, ESC environment, or service.
 */
export class EcsDeploymentCheckpoint extends pulumi.ComponentResource {
  /**
   * Created checkpoint Stage URN. Absent for a verified no-op.
   */
  public readonly stageUrn: pulumi.Output<string | undefined>;
  /**
   * Predecessor for downstream stages. Resolves to the verification Stage in automated mode, the
   * checkpoint Stage in manual mode, or the original upstream Stage after a verified no-op.
   */
  public readonly continuationStageUrn: pulumi.Output<string>;
  /**
   * Matching deployment ARN, or empty string for a verified no-op.
   */
  public readonly deploymentArn: pulumi.Output<string>;
  /**
   * Created verification Job URN. Absent for a verified no-op, unknown until discovery resolves.
   */
  public readonly verificationJobUrn: pulumi.Output<string | undefined>;

  constructor(
    name: string,
    args: EcsDeploymentCheckpointArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('awsx-delivery:index:EcsDeploymentCheckpoint', name, {}, opts);
    if (args.approval && args.automatedTest) {
      throw new Error('Specify either approval or automatedTest, not both');
    }
    pulumi.log.info('ECS checkpoint: waiting for serviceArn', this);
    const service = pulumi.output(args.serviceArn).apply((arn) => {
      pulumi.log.info(
        `ECS checkpoint: parsing serviceArn (present=${arn != null}, type=${typeof arn})`,
        this,
      );
      const parsed = parseEcsServiceArn(arn);
      pulumi.log.info('ECS checkpoint: parsed serviceArn', this);
      return parsed;
    });
    const conditionName = pulumi
      .output(args.conditionName ?? defaultEcsArrivalConditionName)
      .apply((value) => {
        if (!value) {
          throw new pulumi.InputPropertyError({
            propertyPath: 'conditionName',
            reason: 'Provide a nonempty condition name matching the infrastructure hook.',
          });
        }
        return value;
      });
    const timeout = pulumi.output(args.timeoutSeconds ?? 1800).apply((seconds) => {
      if (!Number.isSafeInteger(seconds) || seconds < 1) {
        throw new pulumi.InputPropertyError({
          propertyPath: 'timeoutSeconds',
          reason: 'Use a positive integer number of seconds.',
        });
      }
      return String(seconds);
    });
    // These hydrate existing references, rather than creating resources inside apply.
    const pipeline = pulumi
      .output(args.pipelineUrn)
      .apply((urn) => new delivery.Pipeline(`${name}-pipeline-reference`, undefined!, { urn }));
    const upstream = pulumi
      .output(args.upstreamStageUrn)
      .apply((urn) => new delivery.Stage(`${name}-upstream-reference`, undefined!, { urn }));
    // The SDK lists concrete source classes, but the wire value is only a resource reference.
    // Keep this compatibility assertion local; Delivery validates the referenced source type.
    const source = pulumi
      .output(args.sourceUrn)
      .apply((urn) =>
        getDeliverySource(`${name}-source-reference`, urn),
      ) as unknown as delivery.JobArgs['source'];
    const discovery = new delivery.Job(
      `${name}-discover`,
      {
        stage: upstream,
        source,
        directory: '.',
        command: scriptCommand('discover-ecs-deployment.sh'),
        environment: {
          AWS_REGION: service.region,
          ECS_CLUSTER: service.clusterArn,
          ECS_SERVICE: service.serviceName,
          ECS_TASK_DEFINITION: args.taskDefinitionArn,
          ECS_GATE_STAGE: name,
          ECS_GATE_CONDITION: conditionName,
          ECS_ESC_ENVIRONMENT: args.environment,
        },
      },
      { parent: this },
    );
    this.deploymentArn = discovery.outputs.apply((outputs) => {
      if (outputs?.result === 'no-deployment' && outputs.deploymentArn === '') return '';
      if (
        outputs?.result === 'deployment' &&
        /^arn:[^:]+:ecs:[^:]+:[0-9]+:service-deployment\//.test(outputs.deploymentArn ?? '')
      )
        return outputs.deploymentArn!;
      throw new Error(
        'ECS deployment discovery returned an invalid result. Approval cannot be bypassed.',
      );
    });
    // Delivery supports deferred registration. A verified no-op contributes no checkpoint Stage
    // or verification Job to the graph. Unknown discovery must not select the no-op branch.
    const checkpoint = this.deploymentArn.apply((arn): pulumi.Output<CheckpointResources> => {
      if (!arn) return pulumi.output({ continuationStageUrn: args.upstreamStageUrn });

      const arrival = delivery.manualOutput(
        { name: conditionName, description: 'Wait for ECS test traffic' },
        { parent: this },
      );
      const approval = args.automatedTest
        ? arrival
        : delivery.allOfOutput(
            {
              rules: [
                delivery.approvalOutput(
                  { approvers: args.approval?.approvers, count: args.approval?.count },
                  { parent: this },
                ),
                arrival,
              ],
            },
            { parent: this },
          );
      const stage = new delivery.Stage(
        name,
        { pipeline, from: [upstream], when: approval },
        { parent: this },
      );
      let verificationStage = stage;
      if (args.automatedTest) {
        new delivery.Job(
          `${name}-test`,
          {
            stage,
            source,
            command: args.automatedTest.command,
            directory: args.automatedTest.directory ?? '.',
            environment: args.automatedTest.environment,
          },
          { parent: this },
        );
        verificationStage = new delivery.Stage(
          `${name}-verify`,
          { pipeline, from: [stage] },
          { parent: this },
        );
      }
      const verification = new delivery.Job(
        `${name}-verify`,
        {
          stage: verificationStage,
          source,
          directory: '.',
          command: scriptCommand('wait-for-ecs-deployment.sh', true),
          environment: {
            AWS_REGION: service.region,
            ECS_DEPLOYMENT_ARN: arn,
            ECS_WAIT_TIMEOUT_SECONDS: timeout,
            ECS_ESC_ENVIRONMENT: args.environment,
          },
        },
        { parent: this },
      );
      return pulumi.output({
        stageUrn: stage.urn,
        verificationJobUrn: verification.urn,
        continuationStageUrn: verificationStage.urn,
      });
    });
    this.stageUrn = checkpoint.apply((resources) => resources.stageUrn);
    this.verificationJobUrn = checkpoint.apply((resources) => resources.verificationJobUrn);
    this.continuationStageUrn = checkpoint.continuationStageUrn;
    this.registerOutputs({
      stageUrn: this.stageUrn,
      continuationStageUrn: this.continuationStageUrn,
      deploymentArn: this.deploymentArn,
      verificationJobUrn: this.verificationJobUrn,
    });
  }
}

/**
 * Embed owned scripts so consumers need no repository-relative helper files.
 *
 * @param entry Script to run under ESC credentials.
 * @param verify Whether to pass the discovered ARN and timeout to the polling script.
 * @returns A shell command with a temporary script directory and guaranteed cleanup.
 */
function scriptCommand(entry: string, verify = false): string {
  const files = [
    'find-ecs-deployment.sh',
    'discover-ecs-deployment.sh',
    'wait-for-ecs-deployment.sh',
  ];
  const unpack = files
    .map((file) => {
      const encoded = Buffer.from(fs.readFileSync(path.join(__dirname, 'scripts', file))).toString(
        'base64',
      );
      return `printf '%s' '${encoded}' | base64 -d > "$scripts/${file}"`;
    })
    .join('\n');
  const script = `set -euo pipefail
scripts=$(mktemp -d)
trap 'rm -rf -- "$scripts"' EXIT
${unpack}
pulumi env run "$ECS_ESC_ENVIRONMENT" -- env AWS_REGION="$AWS_REGION" AWS_DEFAULT_REGION="$AWS_REGION" bash "$scripts/${entry}"${verify ? ' "$ECS_DEPLOYMENT_ARN" "$ECS_WAIT_TIMEOUT_SECONDS"' : ''}`;
  return `bash -c '${script.replace(/'/g, `'"'"'`)}'`;
}
