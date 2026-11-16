import { STSServiceException } from '@aws-sdk/client-sts';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { getToken, HttpError } from './authentication.js';
import { invoke, parseCall } from './invoke.js';

const logger = new Logger({ serviceName: 'pulumi-api-hook' });
const metrics = new Metrics({ namespace: 'PulumiDelivery', serviceName: 'pulumi-api-hook' });

const retryLimitMs = 30 * 60 * 1000;
const callbackDelaySeconds = 30;

interface HookEvent {
  hookDetails?: {
    mode?: unknown;
    call?: unknown;
    retryState?: { startedAt: number };
    [key: string]: unknown;
  };
}

export interface HookResult {
  hookStatus: 'SUCCEEDED' | 'FAILED' | 'IN_PROGRESS';
  callBackDelay?: number;
  hookDetails?: HookEvent['hookDetails'];
}

export function retryResult(event: HookEvent, now = Date.now()): HookResult {
  const startedAt = event.hookDetails?.retryState?.startedAt ?? now;
  if (!Number.isFinite(startedAt) || startedAt > now || now - startedAt >= retryLimitMs) {
    return { hookStatus: 'FAILED' };
  }
  return {
    hookStatus: 'IN_PROGRESS',
    callBackDelay: callbackDelaySeconds,
    hookDetails: { ...event.hookDetails, retryState: { startedAt } },
  };
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof STSServiceException) {
    return error.$retryable !== undefined || (error.$metadata.httpStatusCode ?? 0) >= 500;
  }
  // fetch network errors and its request timeout.
  return (
    error instanceof TypeError ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export async function handler(event: HookEvent): Promise<HookResult> {
  try {
    const details = event?.hookDetails;
    if (details?.mode === 'manual') {
      if (details.call !== undefined) throw new Error('Manual mode must not include a Delivery call');
      metrics.addMetric('ManualBypass', MetricUnit.Count, 1);
      logger.info('Manual deployment bypassed Delivery');
      return { hookStatus: 'SUCCEEDED' };
    }
    if (details?.mode !== undefined && details.mode !== 'delivery') {
      throw new Error('Unsupported hook mode');
    }

    const organization = requiredEnvironment('PULUMI_ORGANIZATION');
    const team = requiredEnvironment('PULUMI_TEAM');
    const apiUrl = (process.env.PULUMI_API_URL ?? 'https://api.pulumi.com').replace(/\/$/, '');
    const call = parseCall(event?.hookDetails?.call, organization);
    if (retryResult(event).hookStatus === 'FAILED') return { hookStatus: 'FAILED' };

    const token = await getToken(apiUrl, organization, team);
    if (!(await invoke(apiUrl, token, call))) {
      metrics.addMetric('CallRetry', MetricUnit.Count, 1);
      logger.info('Waiting for Delivery gate');
      return retryResult(event);
    }
    metrics.addMetric('CallSucceeded', MetricUnit.Count, 1);
    logger.info('Pulumi API call succeeded', { service: call.service, action: call.action });
    return { hookStatus: 'SUCCEEDED' };
  } catch (error) {
    const result = isRetryable(error) ? retryResult(event) : { hookStatus: 'FAILED' as const };
    metrics.addMetric(
      result.hookStatus === 'IN_PROGRESS' ? 'CallRetry' : 'CallFailed',
      MetricUnit.Count,
      1,
    );
    // Never log the event, credentials, response bodies, or raw SDK errors.
    logger.warn('Pulumi API call did not complete', {
      hookStatus: result.hookStatus,
      ...(error instanceof HttpError ? { httpStatus: error.status } : {}),
    });
    return result;
  } finally {
    metrics.publishStoredMetrics();
  }
}
