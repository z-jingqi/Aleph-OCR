import { cleanupExpiredJobs, requireStorage, resetExpiredProcessingJobs } from './job-store';
import { deliverDueWebhooks } from './webhooks';
import type { Env } from './types';

export async function runScheduledMaintenance(env: Env) {
  try {
    requireStorage(env);
    const requeued = await resetExpiredProcessingJobs(env);
    const queue = env.TOOLS_JOBS;
    if (queue) {
      await Promise.all(requeued.map((jobId) => queue.send({ jobId })));
    }
    const cleaned = await cleanupExpiredJobs(env);
    await deliverDueWebhooks(env);
    console.log('Tools maintenance complete', JSON.stringify({ cleaned, requeued: requeued.length }));
  } catch (error) {
    console.error('Tools maintenance failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
