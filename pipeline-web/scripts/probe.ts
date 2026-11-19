import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

async function ping(url: string): Promise<void> {
  const response = await fetch(new URL('/api/ping', url), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const result = (await response.json()) as { instanceId?: string; region?: string };
  if (!result.instanceId || !result.region)
    throw new Error(`${url} did not return a dashboard ping`);
}

async function main(): Promise<void> {
  const { CANARY_CANDIDATE_URL, CANARY_PRODUCTION_URL, CANARY_PHASE, CANARY_BAKE_SECONDS } =
    process.env;
  if (!CANARY_CANDIDATE_URL) throw new Error('Missing candidate URL.');
  if (CANARY_PHASE === 'pre-traffic') return ping(CANARY_CANDIDATE_URL);
  if (CANARY_PHASE !== 'canary' || !CANARY_PRODUCTION_URL)
    throw new Error('Missing canary production URL.');
  const deadline = performance.now() + Number(CANARY_BAKE_SECONDS) * 1000;
  // Always probe once, including when the requested bake time is zero.
  let remaining = 0;
  while (remaining >= 0) {
    // oxlint-disable-next-line no-await-in-loop -- Probe both endpoints before the next round.
    await Promise.all([ping(CANARY_CANDIDATE_URL), ping(CANARY_PRODUCTION_URL)]);
    remaining = deadline - performance.now();
    if (remaining <= 0) break;
    // oxlint-disable-next-line no-await-in-loop -- Space out probes over the canary window.
    await delay(Math.min(15_000, remaining));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
