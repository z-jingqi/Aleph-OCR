import { MAX_SYNC_IMAGE_SIZE_BYTES } from '@aleph-tools/shared';
import type { Env } from './types';

export function workflowConfigured(env: Env): boolean {
  return Boolean(env.TOOLS_WORKFLOW ?? env.TOOLS_JOBS);
}

export function maxJobAttempts(env: Env): number {
  const parsed = Number(env.MAX_JOB_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function maxActiveJobsPerClient(env: Env): number | null {
  const raw = env.MAX_ACTIVE_JOBS_PER_CLIENT ?? '20';
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function maxImageUploadBytes(env: Env): number {
  const parsed = Number(env.MAX_IMAGE_UPLOAD_BYTES ?? MAX_SYNC_IMAGE_SIZE_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : MAX_SYNC_IMAGE_SIZE_BYTES;
}

export function syncEndpointsEnabled(env: Env): boolean {
  return truthyFlag(env.ENABLE_SYNC_ENDPOINTS);
}

export function toolsEngineInstanceCount(env: Env): number {
  const parsed = Number(env.TOOLS_ENGINE_INSTANCE_COUNT ?? '4');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}

function truthyFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}
