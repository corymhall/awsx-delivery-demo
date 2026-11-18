import { writeFile } from 'node:fs/promises';
import {
  GetWebFunctionEndpointCommand,
  LambdaWebClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda-web';
import { web } from '../../shared/web.ts';

async function main(): Promise<void> {
  const outputPath = process.env.DELIVERY_OUTPUTS;
  const releaseTag = process.env.DELIVERY_COMMIT;
  if (!outputPath || !releaseTag) throw new Error('Run this as a Delivery job.');
  const client = new LambdaWebClient({ region: web.region });
  let stableRevisionId = '';
  try {
    const endpoint = await client.send(
      new GetWebFunctionEndpointCommand({
        functionName: web.functionName,
        endpointName: web.productionEndpointName,
      }),
    );
    const weights = endpoint.revisionWeights ?? [];
    if (
      endpoint.state !== 'Active' ||
      endpoint.updateStatus === 'InProgress' ||
      weights.length !== 1 ||
      weights[0].weight !== 100 ||
      !weights[0].revisionId
    ) {
      throw new Error(
        'Production is not active on a single revision. Finish or restore the previous rollout first.',
      );
    }
    stableRevisionId = weights[0].revisionId;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    console.log('No production endpoint exists. This run will bootstrap it.');
  }
  await writeFile(outputPath, JSON.stringify({ stableRevisionId, releaseTag }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
