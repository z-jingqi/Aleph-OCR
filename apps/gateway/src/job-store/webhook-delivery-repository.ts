import { mapWebhookDelivery } from './mappers';
import type { JobEvent, JobStoreEnv, StoredJob, WebhookDelivery, WebhookDeliveryRow } from './schema';
import { WEBHOOK_RETRY_DELAYS_SECONDS } from './schema';

export async function createWebhookDeliveryForEvent(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  event: JobEvent,
  payload: Record<string, unknown>,
): Promise<WebhookDelivery | null> {
  if (!job.callbackUrl) return null;
  const timestamp = new Date().toISOString();
  const deliveryId = `whd_${crypto.randomUUID()}`;
  const body = {
    ...payload,
    eventId: event.eventId,
    jobId: job.jobId,
    metadata: job.callbackMetadata ?? {},
    createdAt: event.createdAt,
  };
  await env.DB.prepare(
    `INSERT INTO tool_webhook_deliveries
      (delivery_id, event_id, job_id, client_id, callback_url, payload_json, status, attempt_count,
       next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
  )
    .bind(deliveryId, event.eventId, job.jobId, job.clientId, job.callbackUrl, JSON.stringify(body), 'pending', timestamp, timestamp, timestamp)
    .run();
  return {
    deliveryId,
    eventId: event.eventId,
    jobId: job.jobId,
    clientId: job.clientId,
    callbackUrl: job.callbackUrl,
    payload: body,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function listDueWebhookDeliveries(
  env: JobStoreEnv & { DB: D1Database },
  nowIso = new Date().toISOString(),
): Promise<WebhookDelivery[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM tool_webhook_deliveries
     WHERE status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC
     LIMIT 50`,
  )
    .bind(nowIso)
    .all<WebhookDeliveryRow>();
  return rows.results.map(mapWebhookDelivery);
}

export async function markWebhookDelivered(
  env: JobStoreEnv & { DB: D1Database },
  deliveryId: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE tool_webhook_deliveries
     SET status = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL, last_error = NULL, updated_at = ?
     WHERE delivery_id = ?`,
  )
    .bind('delivered', timestamp, deliveryId)
    .run();
}

export async function markWebhookFailed(
  env: JobStoreEnv & { DB: D1Database },
  delivery: WebhookDelivery,
  error: string,
): Promise<void> {
  const attempts = delivery.attemptCount + 1;
  const retryDelay = WEBHOOK_RETRY_DELAYS_SECONDS[Math.min(attempts - 1, WEBHOOK_RETRY_DELAYS_SECONDS.length - 1)];
  const timestamp = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + retryDelay * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE tool_webhook_deliveries
     SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE delivery_id = ?`,
  )
    .bind('failed', attempts, nextAttemptAt, error, timestamp, delivery.deliveryId)
    .run();
}
