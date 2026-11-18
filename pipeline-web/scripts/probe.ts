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
  const { CANDIDATE_URL, PRODUCTION_URL, STABLE_REVISION, CANDIDATE_REVISION } = process.env;
  if (!CANDIDATE_URL) throw new Error('Missing candidate URL.');
  // The probe without PRODUCTION_URL is the pre-canary smoke test.
  if (!PRODUCTION_URL) return ping(CANDIDATE_URL);
  if (!STABLE_REVISION || STABLE_REVISION === CANDIDATE_REVISION) {
    console.log('No distinct stable revision. Skipping the canary wait.');
    return;
  }
  const deadline = performance.now() + 300_000;
  while (performance.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for each round of probes before scheduling the next.
    await Promise.all([ping(CANDIDATE_URL), ping(PRODUCTION_URL)]);
    // oxlint-disable-next-line no-await-in-loop -- Space out probes over the canary window.
    await delay(Math.min(15_000, Math.max(0, deadline - performance.now())));
  }
  await Promise.all([ping(CANDIDATE_URL), ping(PRODUCTION_URL)]);
  console.log('Five-minute canary completed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
