import { maxActiveJobsGlobal, maxActiveJobsPerClient } from '../config';
import { jsonError } from '../http/responses';
import { countActiveJobs, countActiveJobsForClient, requireStorage } from '../job-store';
import type { AppContext } from '../types';

export async function activeJobLimitResponse(c: AppContext): Promise<Response | null> {
  requireStorage(c.env);
  const globalLimit = maxActiveJobsGlobal(c.env);
  if (globalLimit !== null && (await countActiveJobs(c.env)) >= globalLimit) {
    return jsonError(c, 'RATE_LIMITED', 'Global active job limit reached', 429, {
      retryable: true,
      headers: { 'Retry-After': '30' },
    });
  }

  const clientLimit = maxActiveJobsPerClient(c.env);
  if (clientLimit !== null && (await countActiveJobsForClient(c.env, c.get('clientId'))) >= clientLimit) {
    return jsonError(c, 'RATE_LIMITED', 'Client active job limit reached', 429, {
      retryable: true,
      headers: { 'Retry-After': '30' },
    });
  }

  return null;
}
