import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as delivery from '@pulumi/delivery';
import { getDeliverySource } from './deliverySource';

/**
 * An application stack implementing the WebFunctionCanary rollout contract.
 */
export interface WebFunctionCanaryTarget {
  /**
   * Fully qualified stack name in the same organization.
   */
  stackName: pulumi.Input<string>;
  /**
   * Stack project directory in the source. Default: repository root.
   */
  directory?: pulumi.Input<string>;
}

/**
 * Caller-owned verification, run against the isolated candidate and again during a traffic split.
 */
export interface WebFunctionCanaryVerification {
  /**
   * Shell command. Zero accepts the candidate; a nonzero exit rejects it.
   */
  command: pulumi.Input<string>;
  /**
   * Directory relative to the repository root. Default: repository root.
   */
  directory?: pulumi.Input<string>;
  /**
   * Environment variables supplied to the command. CANARY_ variables are reserved.
   */
  environment?: pulumi.Input<Record<string, pulumi.Input<string>>>;
  /**
   * Commands to prepare verification dependencies, before each verification job. Default: none.
   */
  preRunCommands?: pulumi.Input<pulumi.Input<string>[]>;
  /**
   * Timeout per command invocation. Default: 360 seconds.
   */
  timeoutSeconds?: pulumi.Input<number>;
}

export interface WebFunctionCanaryArgs {
  /**
   * Existing Delivery pipeline URN.
   */
  pipelineUrn: pulumi.Input<string>;
  /**
   * Existing Delivery VCS source URN.
   */
  sourceUrn: pulumi.Input<string>;
  /**
   * Application stack and production endpoint identity.
   */
  target: WebFunctionCanaryTarget;
  /**
   * Fully qualified ESC environment supplying AWS credentials to pipeline jobs.
   */
  awsEnvironment: pulumi.Input<string>;
  /**
   * User-defined candidate verification.
   */
  verification: WebFunctionCanaryVerification;
  /**
   * Percentage of production traffic sent to the candidate. Whole numbers 1 through 99. Default: 10.
   */
  canaryPercent?: pulumi.Input<number>;
  /**
   * Minimum minutes at the canary split before promotion. Default: 5.
   */
  canaryBakeTimeMinutes?: pulumi.Input<number>;
  /**
   * Require one approval before shifting production traffic. Requires Delivery's Approvals feature.
   * Default: false. This does not gate creation of the production endpoint on the first release.
   */
  requireApprovalBeforeShift?: boolean;
}

/**
 * Publishes, verifies, shifts and promotes a Lambda Web Function revision using Delivery. The
 * application stack is the sole traffic writer. A negative canary verdict restores the previous
 * revision before reporting failure. Run only one release at a time per endpoint.
 */
export class WebFunctionCanary extends pulumi.ComponentResource {
  /**
   * Stage URN for downstream work. The stage succeeds only after promotion is confirmed.
   */
  readonly completionStageUrn: pulumi.Output<string>;

  constructor(name: string, args: WebFunctionCanaryArgs, opts?: pulumi.ComponentResourceOptions) {
    super('awsx-delivery:index:WebFunctionCanary', name, {}, opts);
    const child = { parent: this };
    const pipeline = pulumi
      .output(args.pipelineUrn)
      .apply((urn) => new delivery.Pipeline(`${name}-pipeline-reference`, undefined!, { urn }));
    const source = pulumi
      .output(args.sourceUrn)
      .apply((urn) =>
        getDeliverySource(`${name}-source-reference`, urn),
      ) as unknown as delivery.JobArgs['source'];
    const deployStage = new delivery.Stage(`${name}-deploy`, { pipeline }, child);
    const shiftStage = new delivery.Stage(
      `${name}-shift`,
      {
        pipeline,
        from: [deployStage],
        when: args.requireApprovalBeforeShift
          ? delivery.approvalOutput({ count: 1 }, child)
          : undefined,
      },
      child,
    );
    const finalizeStage = new delivery.Stage(
      `${name}-finalize`,
      { pipeline, from: [shiftStage] },
      child,
    );
    const stackDirectory = args.target.directory ?? '.';
    const percent = validateInteger('canaryPercent', args.canaryPercent ?? 10, 1, 99);
    const job = createCanaryJobs(name, args, source, this, percent);

    const baseline = job('snapshot', deployStage).outputs.apply((outputs) => ({
      stableRevisionId: requireString(outputs?.stableRevisionId, 'snapshot.stableRevisionId', true),
      functionArn: requireString(outputs?.functionArn, 'snapshot.functionArn', true),
      productionEndpointArn: requireString(
        outputs?.productionEndpointArn,
        'snapshot.productionEndpointArn',
        true,
      ),
      releaseTag: requireString(outputs?.releaseTag, 'snapshot.releaseTag'),
    }));
    const updateStack = (
      suffix: string,
      stage: delivery.Stage,
      release: pulumi.Input<string>,
      dependsOn?: pulumi.Resource,
    ): delivery.Stacks =>
      new delivery.Stacks(
        `${name}-${suffix}-stack`,
        {
          stage,
          stacks: {
            target: {
              stack: args.target.stackName,
              source,
              directory: stackDirectory,
              config: {
                'webFunctionCanary:release': release,
                'webFunctionCanary:releaseTag': baseline.releaseTag,
              },
            },
          },
        },
        { ...child, dependsOn },
      );
    const published = updateStack(
      'publish',
      deployStage,
      baseline.apply(({ stableRevisionId }) =>
        JSON.stringify({
          stableRevisionId,
          phase: 'publish',
          candidatePercent: stableRevisionId ? 0 : 100,
        }),
      ),
    );
    const candidate = pulumi.all([baseline, published.outputs]).apply(([snapshot, outputs]) => {
      const arn = requireString(outputs?.target?.functionArn, 'functionArn');
      if (snapshot.functionArn && snapshot.functionArn !== arn) {
        throw new Error(
          'The stack published to a different Web Function. Refusing to shift production traffic.',
        );
      }
      const endpointArn = requireString(
        outputs?.target?.productionEndpointArn,
        'productionEndpointArn',
      );
      if (snapshot.productionEndpointArn && snapshot.productionEndpointArn !== endpointArn) {
        throw new Error(
          'The stack published to a different production endpoint. Refusing to shift traffic.',
        );
      }
      return {
        id: requireString(outputs?.target?.candidateRevisionId, 'candidateRevisionId'),
        url: requireString(outputs?.target?.testUrl, 'testUrl'),
        arn,
        endpointArn,
      };
    });
    const candidateEnvironment = {
      CANARY_CANDIDATE_REVISION_ID: candidate.id,
      CANARY_CANDIDATE_URL: candidate.url,
      CANARY_FUNCTION_ARN: candidate.arn,
      CANARY_PRODUCTION_ENDPOINT_ARN: candidate.endpointArn,
      CANARY_STABLE_REVISION_ID: baseline.stableRevisionId,
    };
    job('verify', deployStage, {
      ...candidateEnvironment,
      CANARY_PRODUCTION_URL: productionUrl(published),
    });
    const release = (
      phase: 'shift' | 'finalize',
      weight: pulumi.Input<number>,
    ): pulumi.Output<string> =>
      pulumi
        .all([baseline, candidate, weight])
        .apply(([{ stableRevisionId }, revision, candidatePercent]) =>
          JSON.stringify({
            stableRevisionId,
            phase,
            candidateRevisionId: revision.id,
            candidatePercent,
          }),
        );
    // The stage waits for verification. Check again after any approval wait before writing.
    const preShift = job('pre-shift', shiftStage, candidateEnvironment);
    const shifted = updateStack('shift', shiftStage, release('shift', percent), preShift);
    const observation = job('observe', shiftStage, {
      ...candidateEnvironment,
      CANARY_PRODUCTION_URL: productionUrl(shifted),
    });
    const verdict = observation.outputs.apply((outputs) => {
      if (outputs?.verdict !== 'promote' && outputs?.verdict !== 'restore') {
        throw new Error(
          'Missing or invalid verification verdict. Do not advance production routing.',
        );
      }
      return {
        action: outputs.verdict,
        reason: requireString(outputs.reason, 'observe.reason', outputs.verdict === 'promote'),
      };
    });
    const checkedEndpointArn = (update: delivery.Stacks): pulumi.Output<string> =>
      pulumi.all([candidate, update.outputs]).apply(([publishedCandidate, outputs]) => {
        const arn = requireString(outputs?.target?.productionEndpointArn, 'productionEndpointArn');
        if (arn !== publishedCandidate.endpointArn) {
          throw new Error(
            'The production endpoint changed during the rollout. Check live routing before retrying.',
          );
        }
        return arn;
      });

    // Keep Finalize ungated so either verdict can reach the routing update.
    const finalized = updateStack(
      'finalize',
      finalizeStage,
      release(
        'finalize',
        verdict.action.apply((action) => (action === 'restore' ? 0 : 100)),
      ),
    );
    job('result', finalizeStage, {
      ...candidateEnvironment,
      CANARY_PRODUCTION_ENDPOINT_ARN: checkedEndpointArn(finalized),
      CANARY_VERDICT: verdict.action,
      CANARY_FAILURE_REASON: verdict.reason,
    });
    this.completionStageUrn = finalizeStage.urn;
    this.registerOutputs({ completionStageUrn: this.completionStageUrn });
  }
}

/**
 * Prepare shared runner settings and construct jobs for the rollout stages.
 *
 * @param name Component name.
 * @param args Rollout settings.
 * @param source Delivery source.
 * @param parent Resource owning the jobs.
 * @param percent Validated canary traffic percent.
 * @returns Factory for declaring a rollout job.
 */
function createCanaryJobs(
  name: string,
  args: WebFunctionCanaryArgs,
  source: delivery.JobArgs['source'],
  parent: pulumi.Resource,
  percent: pulumi.Output<number>,
): (
  operation: CanaryOperation,
  stage: delivery.Stage,
  variables?: Record<string, pulumi.Input<string>>,
) => delivery.Job {
  const stackDirectory = args.target.directory ?? '.';
  const bake = validateInteger('canaryBakeTimeMinutes', args.canaryBakeTimeMinutes ?? 5, 0, 1380);
  const timeout = validateInteger(
    'verification.timeoutSeconds',
    args.verification.timeoutSeconds ?? 360,
    1,
    82_800,
  );
  // Leave time for setup, endpoint reads, and emitting the verdict before Delivery kills the job.
  const jobTimeout = pulumi
    .all([bake, timeout])
    .apply(([minutes, seconds]) => `${Math.max(minutes * 60, seconds) + 600}s`);
  const baseEnvironment = {
    CANARY_AWS_ENVIRONMENT: args.awsEnvironment,
    CANARY_STACK: args.target.stackName,
    CANARY_PERCENT: percent.apply(String),
  };
  return (
    suffix: CanaryOperation,
    current: delivery.Stage,
    variables: Record<string, pulumi.Input<string>> = {},
  ): delivery.Job => {
    const runsVerification = suffix === 'verify' || suffix === 'observe';
    const environment = pulumi
      .output(runsVerification ? (args.verification.environment ?? {}) : {})
      .apply((custom) => {
        if (Object.keys(custom).some((key) => key.startsWith('CANARY_'))) {
          throw new pulumi.InputPropertyError({
            propertyPath: 'verification.environment',
            reason: 'Names beginning with CANARY_ are reserved.',
          });
        }
        return {
          ...custom,
          ...baseEnvironment,
          ...variables,
          ...(runsVerification
            ? {
                CANARY_VERIFY_COMMAND: args.verification.command,
                CANARY_VERIFY_TIMEOUT_SECONDS: timeout.apply(String),
                CANARY_BAKE_SECONDS: bake.apply((minutes) => String(minutes * 60)),
                CANARY_PHASE: suffix === 'verify' ? 'pre-traffic' : 'canary',
              }
            : {}),
        };
      });
    return new delivery.Job(
      `${name}-${suffix}-job`,
      {
        stage: current,
        source,
        directory: runsVerification ? (args.verification.directory ?? '.') : stackDirectory,
        preRunCommands: runsVerification ? args.verification.preRunCommands : undefined,
        environment,
        command: scriptCommand(suffix),
        timeout: runsVerification ? jobTimeout : '10m',
      },
      { parent },
    );
  };
}

/**
 * Read the production URL after an application update.
 *
 * @param deployment Application stack update.
 * @returns The validated production URL.
 */
function productionUrl(deployment: delivery.Stacks): pulumi.Output<string> {
  return deployment.outputs.apply((outputs) =>
    requireString(outputs?.target?.productionUrl, 'productionUrl'),
  );
}

type CanaryOperation = 'snapshot' | 'verify' | 'pre-shift' | 'observe' | 'result';

/**
 * Reject absent or incorrectly typed stage outputs.
 *
 * @param value Raw output.
 * @param output Output name for diagnostics.
 * @param allowEmpty Whether an empty string is meaningful.
 * @returns The validated string.
 */
function requireString(value: unknown, output: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`Missing or invalid WebFunctionCanary output: ${output}.`);
  }
  return value;
}

/**
 * Validate a number when its Pulumi input resolves.
 *
 * @param propertyPath Input name for diagnostics.
 * @param input Configured value.
 * @param min Inclusive minimum.
 * @param max Inclusive maximum.
 * @returns The validated integer.
 */
function validateInteger(
  propertyPath: string,
  input: pulumi.Input<number>,
  min: number,
  max: number,
): pulumi.Output<number> {
  return pulumi.output(input).apply((value) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new pulumi.InputPropertyError({
        propertyPath,
        reason: `Use a whole number from ${min} through ${max}. Received ${value}.`,
      });
    }
    return value;
  });
}

/**
 * Stage the owned runner without requiring scripts in the consumer's checkout.
 *
 * @param mode Runner operation.
 * @returns The job command.
 */
function scriptCommand(mode: CanaryOperation): string {
  const runner = fs
    .readFileSync(path.join(__dirname, 'scripts/web-function-canary.cjs'))
    .toString('base64');
  const script = `set -euo pipefail
scripts=$(mktemp -d)
trap 'rm -rf -- "$scripts"' EXIT
printf '%s' '${runner}' | base64 -d > "$scripts/canary.cjs"
npm install --prefix "$scripts" --ignore-scripts --no-audit --no-fund --no-package-lock @aws-sdk/client-lambda-web@3.1171.0
pulumi env run "$CANARY_AWS_ENVIRONMENT" -- node "$scripts/canary.cjs" ${mode}`;
  return `bash -c '${script.replace(/'/g, `'"'"'`)}'`;
}
