import type { Env } from './types';

export function workflowConfigured(env: Env): boolean {
  return Boolean(env.TOOLS_WORKFLOW ?? env.TOOLS_JOBS);
}

export function maxJobAttempts(env: Env): number {
  const parsed = Number(env.MAX_JOB_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function maxActiveJobsPerClient(env: Env): number | null {
  const raw = env.MAX_ACTIVE_JOBS_PER_CLIENT;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
