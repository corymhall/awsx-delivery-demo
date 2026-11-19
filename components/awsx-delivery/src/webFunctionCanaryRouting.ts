import * as pulumi from '@pulumi/pulumi';

export interface WebFunctionCanaryRoutingArgs {
  /**
   * Revision produced by the Web Function for this update.
   */
  candidateRevisionId: pulumi.Input<string>;
}

export interface WebFunctionCanaryRevisionWeight {
  revisionId: string;
  weight: number;
}

/**
 * Validates the Delivery release and computes production weights. This component does not create or
 * update the Web Function or its endpoints.
 */
export class WebFunctionCanaryRouting extends pulumi.ComponentResource {
  /**
   * Candidate revision, checked against the revision recorded by Delivery.
   */
  readonly candidateRevisionId: pulumi.Output<string>;
  /**
   * Weights to pass to the production endpoint.
   */
  readonly productionRevisions: pulumi.Output<WebFunctionCanaryRevisionWeight[]>;

  constructor(
    name: string,
    args: WebFunctionCanaryRoutingArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('awsx-delivery:index:WebFunctionCanaryRouting', name, {}, opts);
    const release = readRelease();
    this.candidateRevisionId = pulumi.output(args.candidateRevisionId).apply((revisionId) => {
      if (
        !revisionId ||
        (release.phase !== 'publish' && revisionId !== release.candidateRevisionId)
      ) {
        throw new Error(
          `Expected candidate revision ${release.candidateRevisionId ?? '(nonempty)'}, but received ${revisionId || '(empty)'}. Refusing to move production traffic.`,
        );
      }
      return revisionId;
    });
    this.productionRevisions = this.candidateRevisionId.apply((revisionId) => {
      const { stableRevisionId, candidatePercent } = release;
      if (!stableRevisionId || candidatePercent === 100 || revisionId === stableRevisionId) {
        return [{ revisionId, weight: 100 }];
      }
      if (candidatePercent === 0) return [{ revisionId: stableRevisionId, weight: 100 }];
      return [
        { revisionId: stableRevisionId, weight: 100 - candidatePercent },
        { revisionId, weight: candidatePercent },
      ];
    });
    this.registerOutputs({
      candidateRevisionId: this.candidateRevisionId,
      productionRevisions: this.productionRevisions,
    });
  }
}

interface Release {
  phase: 'publish' | 'shift' | 'reconcile' | 'finalize';
  stableRevisionId: string;
  candidateRevisionId?: string;
  candidatePercent: number;
}

/**
 * Read and validate the rollout instructions written by Delivery.
 *
 * @returns The release instructions for this update.
 */
function readRelease(): Release {
  const release = new pulumi.Config('webFunctionCanary').requireObject<Release>('release');
  if (!release || typeof release !== 'object')
    throw new Error('Invalid WebFunctionCanary release.');
  const { phase, stableRevisionId, candidatePercent, candidateRevisionId } = release;
  if (
    typeof stableRevisionId !== 'string' ||
    !Number.isInteger(candidatePercent) ||
    !(
      (phase === 'publish' && candidatePercent === (stableRevisionId ? 0 : 100)) ||
      (phase === 'shift' && candidatePercent > 0 && candidatePercent < 100) ||
      (phase === 'reconcile' &&
        candidatePercent >= 0 &&
        candidatePercent < 100 &&
        (candidatePercent > 0 || stableRevisionId)) ||
      (phase === 'finalize' &&
        (candidatePercent === 100 || (candidatePercent === 0 && stableRevisionId)))
    ) ||
    (phase !== 'publish' && (typeof candidateRevisionId !== 'string' || !candidateRevisionId))
  ) {
    throw new Error(
      'Invalid WebFunctionCanary release. Run the Delivery pipeline to configure routing.',
    );
  }
  return release;
}
