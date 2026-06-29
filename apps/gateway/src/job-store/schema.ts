import type {
  ImageCompressOptions,
  ImagePipelineOptions,
  ImageConvertOptions,
  JobStage,
  JobStatus,
  OcrDocument,
  OcrJob,
  OcrJobEvent,
  OcrJobEventType,
  OcrJobPageStatus,
  WebhookDeliveryStatus,
  ToolType,
} from '@aleph-tools/shared';

export interface JobStoreEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  JOB_RETENTION_DAYS?: string;
}

export type JobRow = {
  job_id: string;
  client_id: string;
  status: JobStatus;
  progress: number;
  stage: JobStage | null;
  current_page: number | null;
  total_pages: number | null;
  document_json: string;
  source_r2_key: string;
  result_r2_key: string | null;
  error: string | null;
  attempt_count: number;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  callback_url: string | null;
  callback_metadata_json: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  workflow_id: string | null;
  cancelled_at: string | null;
  tool: ToolType;
  operation: string | null;
  tool_options_json: string | null;
  output_r2_key: string | null;
  output_json: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type EventRow = {
  event_id: string;
  job_id: string;
  client_id: string;
  sequence: number;
  type: OcrJobEventType;
  payload_json: string;
  created_at: string;
};

export type SequenceRow = { sequence: number };

export type ExpiredProcessingRow = { job_id: string };

export type PageRow = {
  job_id: string;
  client_id: string;
  page_index: number;
  status: OcrJobPageStatus;
  attempt_count: number;
  result_r2_key: string | null;
  error: string | null;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookDeliveryRow = {
  delivery_id: string;
  event_id: string;
  job_id: string;
  client_id: string;
  callback_url: string;
  payload_json: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type StoredJob = OcrJob & {
  clientId: string;
  sourceR2Key: string;
  resultR2Key?: string;
  expiresAt: string;
  attemptCount: number;
  processingStartedAt?: string;
  processingLeaseUntil?: string;
  callbackUrl?: string;
  callbackMetadata?: Record<string, unknown>;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  workflowId?: string;
  cancelledAt?: string;
  tool: ToolType;
  operation?: string;
  toolOptions?: Record<string, unknown>;
  outputR2Key?: string;
  output?: Record<string, unknown>;
};

export type JobEvent = OcrJobEvent & {
  clientId: string;
};

export type WebhookDelivery = {
  deliveryId: string;
  eventId: string;
  jobId: string;
  clientId: string;
  callbackUrl: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateJobOptions = {
  callbackUrl?: string;
  callbackMetadata?: Record<string, unknown>;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  workflowId?: string;
  tool?: ToolType;
  operation?: string;
  toolOptions?: ImageConvertOptions | ImageCompressOptions | ImagePipelineOptions | Record<string, unknown>;
};

export type JobProgressPatch = {
  status?: JobStatus;
  progress?: number;
  stage?: JobStage;
  currentPage?: number | null;
  totalPages?: number | null;
  error?: string | null;
  completedAt?: string | null;
};

export const SOURCE_PREFIX = 'sources';
export const RESULT_PREFIX = 'results';
export const OUTPUT_PREFIX = 'outputs';
export const PAGE_RESULT_PREFIX = 'page-results';
export const PROCESSING_LEASE_SECONDS = 15 * 60;
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];
export const TERMINAL_STATUSES = new Set<JobStatus>(['ready', 'failed', 'cancelled', 'deleted']);

export function requireStorage<T extends JobStoreEnv>(env: T): asserts env is T & { DB: D1Database; ASSETS: R2Bucket } {
  if (!env.DB || !env.ASSETS) throw new Error('D1 and R2 bindings are required');
}

export function retentionDays(env: JobStoreEnv): number {
  const parsed = Number(env.JOB_RETENTION_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function safeR2Name(filename: string): string {
  return filename.replace(/[^\w.\-]+/g, '_') || 'upload';
}

export function hasChangedRows(result: D1Result<unknown>): boolean {
  const meta = result.meta as { changes?: number; rows_written?: number } | undefined;
  return (meta?.changes ?? meta?.rows_written ?? 1) > 0;
}
