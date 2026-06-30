import type { OcrDocument } from '@aleph-tools/shared';
import type { EventRow, JobEvent, JobRow, StoredJob, WebhookDelivery, WebhookDeliveryRow } from './schema';

export function mapJob(row: JobRow): StoredJob {
  return {
    jobId: row.job_id,
    clientId: row.client_id,
    status: row.status,
    progress: Number(row.progress ?? 0),
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.current_page !== null && row.current_page !== undefined ? { currentPage: Number(row.current_page) } : {}),
    ...(row.total_pages !== null && row.total_pages !== undefined ? { totalPages: Number(row.total_pages) } : {}),
    document: JSON.parse(row.document_json) as OcrDocument,
    sourceR2Key: row.source_r2_key,
    ...(row.result_r2_key ? { resultR2Key: row.result_r2_key } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    attemptCount: Number(row.attempt_count ?? 0),
    tool: row.tool ?? 'ocr',
    ...(row.operation ? { operation: row.operation } : {}),
    ...(row.tool_options_json ? { toolOptions: JSON.parse(row.tool_options_json) as Record<string, unknown> } : {}),
    ...(row.processing_started_at ? { processingStartedAt: row.processing_started_at } : {}),
    ...(row.processing_lease_until ? { processingLeaseUntil: row.processing_lease_until } : {}),
    ...(row.callback_url ? { callbackUrl: row.callback_url } : {}),
    ...(row.callback_metadata_json ? { callbackMetadata: JSON.parse(row.callback_metadata_json) as Record<string, unknown> } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.idempotency_fingerprint ? { idempotencyFingerprint: row.idempotency_fingerprint } : {}),
    ...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function mapEvent(row: EventRow): JobEvent {
  return {
    eventId: row.event_id,
    jobId: row.job_id,
    clientId: row.client_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export function mapWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    jobId: row.job_id,
    clientId: row.client_id,
    callbackUrl: row.callback_url,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
