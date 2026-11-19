const { execFileSync, spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

const env = process.env;
/**
 * Read a required runner input.
 *
 * @param {string} key Environment variable name.
 * @returns {string} Its nonempty value.
 */
function required(key) {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

/**
 * Emit the runner's authoritative Delivery output.
 *
 * @param {object} value Output map.
 */
function output(value) {
  writeFileSync(required('DELIVERY_OUTPUTS'), JSON.stringify(value));
}

/**
 * Read the active endpoint from the function's home Region.
 *
 * @param {string} arn Web Function ARN from the target stack.
 * @param {string} endpointArn Production endpoint ARN from the target stack.
 * @returns {Promise<object | null>} Live weights, or null only when it does not exist.
 */
async function readRouting(arn, endpointArn) {
  const {
    GetWebFunctionEndpointCommand,
    LambdaWebClient,
    ResourceNotFoundException,
  } = require('@aws-sdk/client-lambda-web');
  const region = arn.match(/^arn:[^:]+:lambda:([^:]+):\d{12}:.+$/)?.[1];
  if (!region)
    throw new Error(
      'Invalid Web Function ARN. Export a nonsecret functionArn from the target stack.',
    );
  const client = new LambdaWebClient({ region });
  try {
    const endpoint = await client.send(
      new GetWebFunctionEndpointCommand({
        functionName: arn,
        endpointName: endpointArn,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (
      endpoint.state !== 'Active' ||
      (endpoint.updateStatus && endpoint.updateStatus !== 'Successful') ||
      !endpoint.revisionWeights?.length
    ) {
      throw new Error(
        `Production routing is not ready: ${endpoint.state}/${endpoint.updateStatus}.`,
      );
    }
    const weights = Object.fromEntries(
      endpoint.revisionWeights.map(({ revisionId, weight }) => {
        if (!revisionId || !Number.isInteger(weight) || weight < 1 || weight > 100) {
          throw new Error('Production returned an invalid revision weight.');
        }
        return [revisionId, weight];
      }),
    );
    if (Object.keys(weights).length !== endpoint.revisionWeights.length) {
      throw new Error('Production returned duplicate revisions.');
    }
    return weights;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return null;
    throw error;
  } finally {
    client.destroy();
  }
}

/**
 * Confirm the expected production state before proceeding.
 *
 * @param {object | null} expected Weights expected at this point in the rollout.
 */
async function requireRouting(expected) {
  const endpointArn = env.CANARY_PRODUCTION_ENDPOINT_ARN;
  const actual = endpointArn
    ? await readRouting(required('CANARY_FUNCTION_ARN'), endpointArn)
    : null;
  const sameRouting =
    actual === null || expected === null
      ? actual === expected
      : Object.keys(actual).length === Object.keys(expected).length &&
        Object.entries(expected).every(([id, weight]) => actual[id] === weight);
  if (!sameRouting) {
    throw new Error(
      `Unexpected production routing. Expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}. Check this rollout before retrying.`,
    );
  }
}

/**
 * Run the caller command in its own group so a timeout also stops ordinary subprocesses.
 *
 * @returns {Promise<string>} A failure reason, or an empty string on success.
 */
function verify() {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    delete childEnv.DELIVERY_OUTPUTS;
    const child = spawn('sh', ['-c', required('CANARY_VERIFY_COMMAND')], {
      detached: true,
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(
      () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') console.error(error);
          }
        }
        resolve('verification timed out');
      },
      Number(required('CANARY_VERIFY_TIMEOUT_SECONDS')) * 1000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve('verification could not start');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? '' : `verification exited with ${code ?? signal}`);
    });
  });
}

/**
 * Perform one rollout operation within its Delivery job.
 *
 * @param {string} mode Runner operation.
 */
async function main(mode) {
  if (mode === 'snapshot') {
    const stackOutputs = JSON.parse(
      execFileSync('pulumi', ['stack', 'output', '--json', '--stack', required('CANARY_STACK')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
    if (!stackOutputs || typeof stackOutputs !== 'object' || Array.isArray(stackOutputs)) {
      throw new Error('Expected a JSON object from the target stack outputs.');
    }
    const functionArn = Object.keys(stackOutputs).length === 0 ? '' : stackOutputs.functionArn;
    if (typeof functionArn !== 'string' || (!functionArn && Object.keys(stackOutputs).length > 0)) {
      throw new Error(
        'The target stack has outputs but is missing functionArn. Refusing to bootstrap.',
      );
    }
    const productionEndpointArn = stackOutputs.productionEndpointArn ?? '';
    if (
      typeof productionEndpointArn !== 'string' ||
      (!productionEndpointArn && stackOutputs.productionUrl)
    ) {
      throw new Error('Missing or invalid productionEndpointArn in the target stack outputs.');
    }
    const routing = productionEndpointArn
      ? await readRouting(functionArn, productionEndpointArn)
      : null;
    if (productionEndpointArn && !routing) {
      throw new Error(
        'The production endpoint exported by the target stack was not found. Refusing to bootstrap.',
      );
    }
    const entries = Object.entries(routing ?? {});
    if (routing && (entries.length !== 1 || !entries[0][0] || entries[0][1] !== 100)) {
      throw new Error(
        'Production does not have a single stable revision. Restore the previous rollout before continuing.',
      );
    }
    output({
      functionArn,
      productionEndpointArn,
      stableRevisionId: entries[0]?.[0] ?? '',
      releaseTag: required('DELIVERY_COMMIT'),
    });
    return;
  }
  const candidate = required('CANARY_CANDIDATE_REVISION_ID');
  const stable = env.CANARY_STABLE_REVISION_ID;
  const percent = Number(required('CANARY_PERCENT'));
  const split = stable && stable !== candidate;
  if (mode === 'verify') {
    const expected = { [stable || candidate]: 100 };
    await requireRouting(expected);
    const failure = await verify();
    if (failure) throw new Error(failure);
    await requireRouting(expected);
    return;
  }
  if (mode === 'observe') {
    const expected = split
      ? { [stable]: 100 - percent, [candidate]: percent }
      : { [stable || candidate]: 100 };
    await requireRouting(expected);
    let failure = '';
    if (split) {
      const start = performance.now();
      failure = await verify();
      if (!failure)
        await delay(
          Math.max(0, Number(required('CANARY_BAKE_SECONDS')) * 1000 - (performance.now() - start)),
        );
    }
    await requireRouting(expected);
    if (failure) console.error(`${failure}. Restoring ${stable} before failing this release.`);
    output({ verdict: failure ? 'restore' : 'promote', reason: failure });
    return;
  }
  if (mode === 'result') {
    const verdict = required('CANARY_VERDICT');
    if (verdict !== 'promote' && verdict !== 'restore') throw new Error('Invalid canary verdict.');
    const revision = verdict === 'restore' ? required('CANARY_STABLE_REVISION_ID') : candidate;
    await requireRouting({ [revision]: 100 });
    if (verdict === 'restore')
      throw new Error(
        `${required('CANARY_FAILURE_REASON')}. Restored stable revision ${revision}.`,
      );
    console.log(`Verified production at 100% on ${revision}.`);
    return;
  }
  throw new Error(`Unknown canary operation: ${mode}`);
}

if (require.main === module) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
