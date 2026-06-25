import type {
  ImageConvertOptions,
  JobStage,
  JobStatus,
  OcrDocument,
  OcrJob,
  OcrJobEvent,
  OcrJobEventType,
  OcrPage,
  OcrJobPageStatus,
  OcrResult,
  ToolResult,
  ToolType,
  ImageConvertResult,
  WebhookDeliveryStatus,
} from '@aleph-tools/shared';

export interface JobStoreEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  JOB_RETENTION_DAYS?: string;
}

type JobRow = {
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

type EventRow = {
  event_id: string;
  job_id: string;
  client_id: string;
  sequence: number;
  type: OcrJobEventType;
  payload_json: string;
  created_at: string;
};

type SequenceRow = { sequence: number };

type ExpiredProcessingRow = { job_id: string };

type PageRow = {
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

type WebhookDeliveryRow = {
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
  toolOptions?: ImageConvertOptions | Record<string, unknown>;
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

const SOURCE_PREFIX = 'sources';
const RESULT_PREFIX = 'results';
const OUTPUT_PREFIX = 'outputs';
const PAGE_RESULT_PREFIX = 'page-results';
const PROCESSING_LEASE_SECONDS = 15 * 60;
const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];
const TERMINAL_STATUSES = new Set<JobStatus>(['ready', 'failed', 'cancelled', 'deleted']);

export function requireStorage<T extends JobStoreEnv>(env: T): asserts env is T & { DB: D1Database; ASSETS: R2Bucket } {
  if (!env.DB || !env.ASSETS) throw new Error('D1 and R2 bindings are required');
}

export async function createJob(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  clientId: string,
  document: OcrDocument,
  file: File,
  options: CreateJobOptions = {},
): Promise<StoredJob> {
  if (options.idempotencyKey) {
    const existing = await getJobByIdempotencyKey(env, clientId, options.idempotencyKey);
    if (existing) return existing;
  }

  const now = new Date();
  const jobId = `ocr_${crypto.randomUUID()}`;
  const sourceR2Key = `${SOURCE_PREFIX}/${clientId}/${jobId}/${safeR2Name(document.filename)}`;
  const expiresAt = new Date(now.getTime() + retentionDays(env) * 86400000).toISOString();
  await env.ASSETS.put(sourceR2Key, file.stream(), {
    httpMetadata: { contentType: document.mimeType || 'application/octet-stream' },
    customMetadata: { jobId, clientId },
  });

  const timestamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO ocr_jobs
      (job_id, client_id, status, progress, stage, current_page, total_pages, document_json, source_r2_key, result_r2_key,
       error, attempt_count, processing_started_at, processing_lease_until, callback_url, callback_metadata_json,
       idempotency_key, idempotency_fingerprint, workflow_id, cancelled_at, tool, operation, tool_options_json, output_r2_key, output_json,
       completed_at, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  )
    .bind(
      jobId,
      clientId,
      'queued',
      0,
      'queued',
      JSON.stringify(document),
      sourceR2Key,
      options.callbackUrl ?? null,
      options.callbackMetadata ? JSON.stringify(options.callbackMetadata) : null,
      options.idempotencyKey ?? null,
      options.idempotencyFingerprint ?? null,
      options.workflowId ?? null,
      options.tool ?? 'ocr',
      options.operation ?? null,
      options.toolOptions ? JSON.stringify(options.toolOptions) : null,
      timestamp,
      timestamp,
      expiresAt,
    )
    .run();

  const job = {
    jobId,
    clientId,
    status: 'queued' as const,
    progress: 0,
    stage: 'queued' as const,
    document,
    sourceR2Key,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt,
    attemptCount: 0,
    tool: options.tool ?? 'ocr',
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.toolOptions ? { toolOptions: options.toolOptions } : {}),
    ...(options.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
    ...(options.callbackMetadata ? { callbackMetadata: options.callbackMetadata } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.idempotencyFingerprint ? { idempotencyFingerprint: options.idempotencyFingerprint } : {}),
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
  };

  await appendJobEvent(env, job, 'job.created');
  return job;
}

export async function getJobByIdempotencyKey(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
  idempotencyKey: string,
): Promise<StoredJob | null> {
  const row = await env.DB.prepare('SELECT * FROM ocr_jobs WHERE client_id = ? AND idempotency_key = ?')
    .bind(clientId, idempotencyKey)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function countActiveJobsForClient(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT job_id FROM ocr_jobs
     WHERE client_id = ? AND status IN ('queued', 'processing', 'cancel_requested')
     LIMIT 1000`,
  )
    .bind(clientId)
    .all<{ job_id: string }>();
  return rows.results.length;
}

export async function getJob(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
  jobId: string,
): Promise<StoredJob | null> {
  const row = await env.DB.prepare('SELECT * FROM ocr_jobs WHERE job_id = ? AND client_id = ?')
    .bind(jobId, clientId)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function getJobForProcessing(
  env: JobStoreEnv & { DB: D1Database },
  jobId: string,
): Promise<StoredJob | null> {
  const row = await env.DB.prepare('SELECT * FROM ocr_jobs WHERE job_id = ?').bind(jobId).first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function claimJobForProcessing(
  env: JobStoreEnv & { DB: D1Database },
  jobId: string,
  leaseSeconds = PROCESSING_LEASE_SECONDS,
): Promise<StoredJob | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, error = NULL, attempt_count = attempt_count + 1,
         processing_started_at = ?, processing_lease_until = ?, updated_at = ?
     WHERE job_id = ?
       AND status IN ('queued', 'failed')
       AND status NOT IN ('deleted', 'cancel_requested', 'cancelled', 'ready')`,
  )
    .bind('processing', 10, 'processing', nowIso, leaseUntil, nowIso, jobId)
    .run();

  if (!hasChangedRows(result)) return null;
  const job = await getJobForProcessing(env, jobId);
  if (job) await appendJobEvent(env, job, 'job.status');
  return job;
}

export async function attachWorkflowId(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  workflowId: string,
): Promise<StoredJob> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare('UPDATE ocr_jobs SET workflow_id = ?, updated_at = ? WHERE job_id = ? AND workflow_id IS NULL')
    .bind(workflowId, timestamp, job.jobId)
    .run();
  return (await getJobForProcessing(env, job.jobId)) ?? { ...job, workflowId };
}

export async function requestJobCancel(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
  jobId: string,
): Promise<StoredJob | null> {
  const job = await getJob(env, clientId, jobId);
  if (!job) return null;
  if (TERMINAL_STATUSES.has(job.status)) return job;

  const timestamp = new Date().toISOString();
  const nextStatus: JobStatus = job.status === 'queued' ? 'cancelled' : 'cancel_requested';
  const nextStage: JobStage = job.status === 'queued' ? 'cancelled' : 'cancel_requested';
  await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, processing_started_at = NULL, processing_lease_until = NULL,
         cancelled_at = ?, completed_at = ?, updated_at = ?
     WHERE job_id = ? AND client_id = ? AND status NOT IN ('ready', 'failed', 'cancelled', 'deleted')`,
  )
    .bind(
      nextStatus,
      nextStatus === 'cancelled' ? 100 : job.progress,
      nextStage,
      timestamp,
      nextStatus === 'cancelled' ? timestamp : null,
      timestamp,
      jobId,
      clientId,
    )
    .run();

  const updated = await getJob(env, clientId, jobId);
  if (updated) {
    const eventType: OcrJobEventType = updated.status === 'cancelled' ? 'job.cancelled' : 'job.cancel_requested';
    const event = await appendJobEvent(env, updated, eventType);
    if (updated.status === 'cancelled') await createCancelledWebhook(env, updated, event);
  }
  return updated;
}

export async function completeCancelledJob(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
): Promise<StoredJob> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, processing_started_at = NULL, processing_lease_until = NULL,
         cancelled_at = COALESCE(cancelled_at, ?), completed_at = ?, updated_at = ?
     WHERE job_id = ? AND status IN ('cancel_requested', 'processing', 'queued')`,
  )
    .bind('cancelled', 100, 'cancelled', timestamp, timestamp, timestamp, job.jobId)
    .run();
  const updated = await getJobForProcessing(env, job.jobId);
  if (!updated) throw new Error('Cancelled job not found');
  const event = await appendJobEvent(env, updated, 'job.cancelled');
  await createCancelledWebhook(env, updated, event);
  return updated;
}

export function isTerminalJob(job: StoredJob): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

export function isCancelRequested(job: StoredJob): boolean {
  return job.status === 'cancel_requested' || job.status === 'cancelled';
}

export async function resetExpiredProcessingJobs(
  env: JobStoreEnv & { DB: D1Database },
  nowIso = new Date().toISOString(),
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT job_id FROM ocr_jobs
     WHERE status = ? AND processing_lease_until IS NOT NULL AND processing_lease_until <= ?
     LIMIT 100`,
  )
    .bind('processing', nowIso)
    .all<ExpiredProcessingRow>();
  const jobIds = rows.results.map((row) => row.job_id);
  for (const jobId of jobIds) {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE ocr_jobs
       SET status = ?, progress = ?, stage = ?, error = ?, processing_started_at = NULL, processing_lease_until = NULL, updated_at = ?
       WHERE job_id = ? AND status = ?`,
    )
      .bind('queued', 0, 'queued', 'Processing lease expired; job was requeued', timestamp, jobId, 'processing')
      .run();
    const job = await getJobForProcessing(env, jobId);
    if (job) await appendJobEvent(env, job, 'job.status');
  }
  return jobIds;
}

export async function getSourceFile(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<R2ObjectBody | null> {
  return env.ASSETS.get(job.sourceR2Key);
}

export async function getResult(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<ToolResult | null> {
  if (!job.resultR2Key) return null;
  const object = await env.ASSETS.get(job.resultR2Key);
  if (!object) return null;
  return JSON.parse(await object.text()) as ToolResult;
}

export async function getOutputFile(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<R2ObjectBody | null> {
  if (!job.outputR2Key) return null;
  return env.ASSETS.get(job.outputR2Key);
}

export async function initializeJobPages(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  totalPages: number,
): Promise<void> {
  const timestamp = new Date().toISOString();
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ocr_job_pages
        (job_id, client_id, page_index, status, attempt_count, result_r2_key, error,
         processing_started_at, processing_lease_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(job.jobId, job.clientId, pageIndex, 'queued', timestamp, timestamp)
      .run();
  }
}

export async function claimJobPage(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  pageIndex: number,
  leaseSeconds = PROCESSING_LEASE_SECONDS,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE ocr_job_pages
     SET status = ?, attempt_count = attempt_count + 1, error = NULL,
         processing_started_at = ?, processing_lease_until = ?, updated_at = ?
     WHERE job_id = ? AND page_index = ? AND status IN ('queued', 'failed')`,
  )
    .bind('processing', nowIso, leaseUntil, nowIso, job.jobId, pageIndex)
    .run();
  return hasChangedRows(result);
}

export async function setJobPageResult(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
  page: OcrPage,
): Promise<StoredJob> {
  const resultR2Key = `${PAGE_RESULT_PREFIX}/${job.clientId}/${job.jobId}/page-${page.pageIndex + 1}.json`;
  await env.ASSETS.put(resultR2Key, JSON.stringify(page), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { jobId: job.jobId, clientId: job.clientId, pageIndex: String(page.pageIndex) },
  });

  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ocr_job_pages
     SET status = ?, result_r2_key = ?, error = NULL, processing_started_at = NULL,
         processing_lease_until = NULL, updated_at = ?
     WHERE job_id = ? AND page_index = ?`,
  )
    .bind('ready', resultR2Key, timestamp, job.jobId, page.pageIndex)
    .run();

  const readyPages = await countReadyPages(env, job.jobId);
  const totalPages = job.totalPages ?? readyPages;
  const progress = totalPages > 0 ? Math.min(95, Math.max(10, Math.floor((readyPages / totalPages) * 90))) : job.progress;
  const updated = await updateJobProgress(
    env,
    job,
    { progress, stage: 'storing_page', currentPage: readyPages, totalPages },
    'job.page.ready',
  );
  return updated;
}

export async function failJobPage(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  pageIndex: number,
  error: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ocr_job_pages
     SET status = ?, error = ?, processing_started_at = NULL, processing_lease_until = NULL, updated_at = ?
     WHERE job_id = ? AND page_index = ?`,
  )
    .bind('failed', error, timestamp, job.jobId, pageIndex)
    .run();
}

export async function getJobPages(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
): Promise<PageRow[]> {
  const rows = await env.DB.prepare('SELECT * FROM ocr_job_pages WHERE job_id = ? ORDER BY page_index ASC')
    .bind(job.jobId)
    .all<PageRow>();
  return rows.results;
}

export async function getPageResults(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
): Promise<OcrPage[]> {
  const pages = await getJobPages(env, job);
  const results: OcrPage[] = [];
  for (const page of pages) {
    if (!page.result_r2_key) throw new Error(`Page ${page.page_index + 1} result is missing`);
    const object = await env.ASSETS.get(page.result_r2_key);
    if (!object) throw new Error(`Page ${page.page_index + 1} result object is missing`);
    results.push(JSON.parse(await object.text()) as OcrPage);
  }
  return results.sort((a, b) => a.pageIndex - b.pageIndex);
}

async function countReadyPages(env: JobStoreEnv & { DB: D1Database }, jobId: string): Promise<number> {
  const rows = await env.DB.prepare('SELECT * FROM ocr_job_pages WHERE job_id = ? AND status = ?')
    .bind(jobId, 'ready')
    .all<PageRow>();
  return rows.results.length;
}

export async function updateJobProgress(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  patch: JobProgressPatch,
  eventType: OcrJobEventType = 'job.progress',
): Promise<StoredJob> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = COALESCE(?, status),
         progress = COALESCE(?, progress),
         stage = COALESCE(?, stage),
         current_page = ?,
         total_pages = ?,
         error = ?,
         completed_at = ?,
         updated_at = ?
     WHERE job_id = ?`,
  )
    .bind(
      patch.status ?? null,
      patch.progress ?? null,
      patch.stage ?? null,
      patch.currentPage === undefined ? job.currentPage ?? null : patch.currentPage,
      patch.totalPages === undefined ? job.totalPages ?? null : patch.totalPages,
      patch.error === undefined ? job.error ?? null : patch.error,
      patch.completedAt === undefined ? job.completedAt ?? null : patch.completedAt,
      timestamp,
      job.jobId,
    )
    .run();

  const updated = await getJobForProcessing(env, job.jobId);
  if (!updated) throw new Error('Updated job not found');
  await appendJobEvent(env, updated, eventType);
  return updated;
}

export async function setJobStatus(
  env: JobStoreEnv & { DB: D1Database },
  jobId: string,
  status: JobStatus,
  error?: string,
): Promise<void> {
  const job = await getJobForProcessing(env, jobId);
  if (!job) return;
  await updateJobProgress(
    env,
    job,
    {
      status,
      progress: ['ready', 'cancelled'].includes(status) ? 100 : job.progress,
      stage: status as JobStage,
      error: error ?? null,
      completedAt: ['ready', 'failed', 'cancelled'].includes(status) ? new Date().toISOString() : null,
    },
    status === 'failed' ? 'job.failed' : status === 'ready' ? 'job.ready' : status === 'cancelled' ? 'job.cancelled' : 'job.status',
  );
}

export async function setJobResult(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
  result: OcrResult,
): Promise<StoredJob> {
  const resultR2Key = `${RESULT_PREFIX}/${job.clientId}/${job.jobId}.json`;
  const readyResult: OcrResult = { ...result, jobId: job.jobId, status: 'ready' };
  await env.ASSETS.put(resultR2Key, JSON.stringify(readyResult), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { jobId: job.jobId, clientId: job.clientId },
  });

  const completedAt = new Date().toISOString();
  const update = await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, current_page = ?, total_pages = ?, result_r2_key = ?,
         error = NULL, processing_started_at = NULL, processing_lease_until = NULL, completed_at = ?, updated_at = ?
     WHERE job_id = ? AND status NOT IN ('cancel_requested', 'cancelled', 'deleted')`,
  )
    .bind(
      'ready',
      100,
      'ready',
      readyResult.pages.length ? readyResult.pages.length : null,
      readyResult.pages.length || null,
      resultR2Key,
      completedAt,
      completedAt,
      job.jobId,
    )
    .run();
  if (!hasChangedRows(update)) {
    await env.ASSETS.delete(resultR2Key);
    const latest = await getJobForProcessing(env, job.jobId);
    if (latest && isCancelRequested(latest)) await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled before result could be stored');
  }

  const updated = await getJobForProcessing(env, job.jobId);
  if (!updated) throw new Error('Ready job not found');
  const event = await appendJobEvent(env, updated, 'job.ready', { resultUrl: `/v1/jobs/${job.jobId}/result` });
  await createWebhookDeliveryForEvent(env, updated, event, {
    event: 'ocr.job.ready',
    job: publicJob(updated),
    resultUrl: `/v1/jobs/${job.jobId}/result`,
  });
  return updated;
}

export async function setImageConvertResult(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
  output: { bytes: ArrayBuffer; filename: string; mimeType: string; width: number; height: number; format: 'png' | 'jpeg' | 'webp' | 'avif' },
): Promise<StoredJob> {
  const outputR2Key = `${OUTPUT_PREFIX}/${job.clientId}/${job.jobId}/${safeR2Name(output.filename)}`;
  await env.ASSETS.put(outputR2Key, output.bytes, {
    httpMetadata: { contentType: output.mimeType },
    customMetadata: { jobId: job.jobId, clientId: job.clientId, tool: 'image.convert' },
  });

  const resultR2Key = `${RESULT_PREFIX}/${job.clientId}/${job.jobId}.json`;
  const result: ImageConvertResult = {
    jobId: job.jobId,
    status: 'ready',
    tool: 'image.convert',
    output: {
      filename: output.filename,
      mimeType: output.mimeType,
      sizeBytes: output.bytes.byteLength,
      width: output.width,
      height: output.height,
      format: output.format,
      resultUrl: `/v1/jobs/${job.jobId}/output`,
    },
    metadata: job.callbackMetadata ?? {},
  };
  await env.ASSETS.put(resultR2Key, JSON.stringify(result), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { jobId: job.jobId, clientId: job.clientId, tool: 'image.convert' },
  });

  const completedAt = new Date().toISOString();
  const update = await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, current_page = ?, total_pages = ?, result_r2_key = ?,
         output_r2_key = ?, output_json = ?, error = NULL, processing_started_at = NULL,
         processing_lease_until = NULL, completed_at = ?, updated_at = ?
     WHERE job_id = ? AND status NOT IN ('cancel_requested', 'cancelled', 'deleted')`,
  )
    .bind('ready', 100, 'ready', 1, 1, resultR2Key, outputR2Key, JSON.stringify(result.output), completedAt, completedAt, job.jobId)
    .run();
  if (!hasChangedRows(update)) {
    await Promise.all([env.ASSETS.delete(outputR2Key), env.ASSETS.delete(resultR2Key)]);
    const latest = await getJobForProcessing(env, job.jobId);
    if (latest && isCancelRequested(latest)) await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled before result could be stored');
  }

  const updated = await getJobForProcessing(env, job.jobId);
  if (!updated) throw new Error('Ready image conversion job not found');
  const event = await appendJobEvent(env, updated, 'job.ready', { resultUrl: `/v1/jobs/${job.jobId}/result`, outputUrl: `/v1/jobs/${job.jobId}/output` });
  await createWebhookDeliveryForEvent(env, updated, event, {
    event: 'tool.job.ready',
    job: publicJob(updated),
    resultUrl: `/v1/jobs/${job.jobId}/result`,
    outputUrl: `/v1/jobs/${job.jobId}/output`,
  });
  return updated;
}

export async function failJob(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  error: string,
): Promise<StoredJob> {
  const latest = await getJobForProcessing(env, job.jobId);
  if (latest && isCancelRequested(latest)) return completeCancelledJob(env, latest);
  const updated = await updateJobProgress(
    env,
    job,
    {
      status: 'failed',
      stage: 'failed',
      error,
      completedAt: new Date().toISOString(),
    },
    'job.failed',
  );
  const events = await listJobEvents(env, job.clientId, job.jobId);
  const event = events.at(-1);
  if (event) {
    await createWebhookDeliveryForEvent(env, updated, event, {
      event: updated.tool === 'ocr' ? 'ocr.job.failed' : 'tool.job.failed',
      job: publicJob(updated),
      error: {
        code: 'JOB_FAILED',
        message: error,
        jobStatus: updated.status,
        stage: updated.stage,
        retryable: false,
        terminal: true,
      },
    });
  }
  return updated;
}

async function createCancelledWebhook(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  event: JobEvent,
): Promise<void> {
  await createWebhookDeliveryForEvent(env, job, event, {
    event: job.tool === 'ocr' ? 'ocr.job.cancelled' : 'tool.job.cancelled',
    job: publicJob(job),
    error: {
      code: 'JOB_CANCELLED',
      message: 'Job was cancelled',
      jobStatus: job.status,
      stage: job.stage,
      retryable: false,
      terminal: true,
    },
  });
}

export async function deleteJob(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  clientId: string,
  jobId: string,
): Promise<OcrJob | null> {
  const job = await getJob(env, clientId, jobId);
  if (!job) return null;
  await deleteJobObjects(env, job);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ocr_jobs
     SET status = ?, progress = ?, stage = ?, result_r2_key = NULL, processing_started_at = NULL,
         processing_lease_until = NULL, completed_at = ?, updated_at = ?
     WHERE job_id = ? AND client_id = ?`,
  )
    .bind('deleted', 100, 'deleted', timestamp, timestamp, jobId, clientId)
    .run();
  const updated = await getJob(env, clientId, jobId);
  if (updated) await appendJobEvent(env, updated, 'job.deleted');
  return updated ? publicJob(updated) : { ...publicJob(job), status: 'deleted', progress: 100, updatedAt: timestamp };
}

export async function cleanupExpiredJobs(env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket }): Promise<number> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare('SELECT * FROM ocr_jobs WHERE expires_at <= ? AND status != ? LIMIT 100')
    .bind(now, 'deleted')
    .all<JobRow>();
  let cleaned = 0;
  for (const row of rows.results) {
    const job = mapJob(row);
    await deleteJobObjects(env, job);
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE ocr_jobs
       SET status = ?, progress = ?, stage = ?, result_r2_key = NULL, processing_started_at = NULL,
           processing_lease_until = NULL, completed_at = ?, updated_at = ?
       WHERE job_id = ?`,
    )
      .bind('deleted', 100, 'deleted', timestamp, timestamp, job.jobId)
      .run();
    const updated = await getJobForProcessing(env, job.jobId);
    if (updated) await appendJobEvent(env, updated, 'job.deleted');
    cleaned += 1;
  }
  return cleaned;
}

export async function appendJobEvent(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  type: OcrJobEventType,
  extraPayload: Record<string, unknown> = {},
): Promise<JobEvent> {
  const sequenceRow = await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM ocr_job_events WHERE job_id = ?')
    .bind(job.jobId)
    .first<SequenceRow>();
  const sequence = sequenceRow?.sequence ?? 1;
  const eventId = `evt_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const payload = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    job: publicJob(job),
    ...(job.currentPage !== undefined ? { currentPage: job.currentPage } : {}),
    ...(job.totalPages !== undefined ? { totalPages: job.totalPages } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...extraPayload,
  };

  await env.DB.prepare(
    `INSERT INTO ocr_job_events (event_id, job_id, client_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(eventId, job.jobId, job.clientId, sequence, type, JSON.stringify(payload), createdAt)
    .run();

  return { eventId, jobId: job.jobId, clientId: job.clientId, sequence, type, payload, createdAt };
}

export async function listJobEvents(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
  jobId: string,
  afterSequence = 0,
): Promise<JobEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM ocr_job_events
     WHERE job_id = ? AND client_id = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT 100`,
  )
    .bind(jobId, clientId, afterSequence)
    .all<EventRow>();
  return rows.results.map(mapEvent);
}

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
    `INSERT INTO ocr_webhook_deliveries
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
    `SELECT * FROM ocr_webhook_deliveries
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
    `UPDATE ocr_webhook_deliveries
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
    `UPDATE ocr_webhook_deliveries
     SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE delivery_id = ?`,
  )
    .bind('failed', attempts, nextAttemptAt, error, timestamp, delivery.deliveryId)
    .run();
}

export function publicJob(job: StoredJob): OcrJob {
  const terminal = TERMINAL_STATUSES.has(job.status);
  return {
    jobId: job.jobId,
    tool: job.tool,
    ...(job.operation ? { operation: job.operation } : {}),
    status: job.status,
    progress: job.progress,
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.currentPage !== undefined ? { currentPage: job.currentPage } : {}),
    ...(job.totalPages !== undefined ? { totalPages: job.totalPages } : {}),
    document: job.document,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
    terminal,
    cancelable: job.status === 'queued' || job.status === 'processing',
    retryable: !terminal || job.status === 'failed',
    resultAvailable: job.status === 'ready' && Boolean(job.resultR2Key),
    outputAvailable: job.status === 'ready' && Boolean(job.outputR2Key),
  };
}

function mapJob(row: JobRow): StoredJob {
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
    ...(row.output_r2_key ? { outputR2Key: row.output_r2_key } : {}),
    ...(row.output_json ? { output: JSON.parse(row.output_json) as Record<string, unknown> } : {}),
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

function mapEvent(row: EventRow): JobEvent {
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

function mapWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
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

async function deleteJobObjects(env: JobStoreEnv & { ASSETS: R2Bucket }, job: StoredJob): Promise<void> {
  const pagePrefix = `${PAGE_RESULT_PREFIX}/${job.clientId}/${job.jobId}/`;
  const pageDeletes: Promise<void>[] = [];
  if ('list' in env.ASSETS) {
    const listed = await env.ASSETS.list({ prefix: pagePrefix });
    pageDeletes.push(...listed.objects.map((object) => env.ASSETS.delete(object.key)));
  }
  await Promise.all([
    env.ASSETS.delete(job.sourceR2Key),
    ...(job.resultR2Key ? [env.ASSETS.delete(job.resultR2Key)] : []),
    ...(job.outputR2Key ? [env.ASSETS.delete(job.outputR2Key)] : []),
    ...pageDeletes,
  ]);
}

function retentionDays(env: JobStoreEnv): number {
  const parsed = Number(env.JOB_RETENTION_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

function safeR2Name(filename: string): string {
  return filename.replace(/[^\w.\-]+/g, '_') || 'upload';
}

function hasChangedRows(result: D1Result<unknown>): boolean {
  const meta = result.meta as { changes?: number; rows_written?: number } | undefined;
  return (meta?.changes ?? meta?.rows_written ?? 1) > 0;
}
