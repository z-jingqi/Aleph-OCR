import type {
  ImageCompressResult,
  ImageConvertResult,
  ImageCompressFormat,
  JobStage,
  JobStatus,
  OcrDocument,
  OcrJob,
  OcrJobEventType,
  OcrPage,
  OcrResult,
} from '@aleph-tools/shared';
import { appendJobEvent, listJobEvents } from './event-repository';
import { mapJob } from './mappers';
import { deleteJobObjects } from './object-store';
import { countReadyPages } from './page-repository';
import { publicJob, isCancelRequested, isTerminalJob } from './public-snapshot';
import {
  PAGE_RESULT_PREFIX,
  PROCESSING_LEASE_SECONDS,
  RESULT_PREFIX,
  OUTPUT_PREFIX,
  SOURCE_PREFIX,
  TERMINAL_STATUSES,
  hasChangedRows,
  retentionDays,
  safeR2Name,
  type CreateJobOptions,
  type ExpiredProcessingRow,
  type JobEvent,
  type JobProgressPatch,
  type JobRow,
  type JobStoreEnv,
  type StoredJob,
} from './schema';
import { createWebhookDeliveryForEvent } from './webhook-delivery-repository';

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
  const jobId = `job_${crypto.randomUUID()}`;
  const sourceR2Key = `${SOURCE_PREFIX}/${clientId}/${jobId}/${safeR2Name(document.filename)}`;
  const expiresAt = new Date(now.getTime() + retentionDays(env) * 86400000).toISOString();
  await env.ASSETS.put(sourceR2Key, file.stream(), {
    httpMetadata: { contentType: document.mimeType || 'application/octet-stream' },
    customMetadata: { jobId, clientId },
  });

  const timestamp = now.toISOString();
  const tool = options.tool ?? 'ocr';
  const operation = options.operation ?? tool;
  await env.DB.prepare(
    `INSERT INTO tool_jobs
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
      tool,
      operation,
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
    tool,
    operation,
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
  const row = await env.DB.prepare('SELECT * FROM tool_jobs WHERE client_id = ? AND idempotency_key = ?')
    .bind(clientId, idempotencyKey)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function countActiveJobsForClient(
  env: JobStoreEnv & { DB: D1Database },
  clientId: string,
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT job_id FROM tool_jobs
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
  const row = await env.DB.prepare('SELECT * FROM tool_jobs WHERE job_id = ? AND client_id = ?')
    .bind(jobId, clientId)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function getJobForProcessing(
  env: JobStoreEnv & { DB: D1Database },
  jobId: string,
): Promise<StoredJob | null> {
  const row = await env.DB.prepare('SELECT * FROM tool_jobs WHERE job_id = ?').bind(jobId).first<JobRow>();
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
    `UPDATE tool_jobs
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
  await env.DB.prepare('UPDATE tool_jobs SET workflow_id = ?, updated_at = ? WHERE job_id = ? AND workflow_id IS NULL')
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
    `UPDATE tool_jobs
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
    `UPDATE tool_jobs
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

export async function resetExpiredProcessingJobs(
  env: JobStoreEnv & { DB: D1Database },
  nowIso = new Date().toISOString(),
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT job_id FROM tool_jobs
     WHERE status = ? AND processing_lease_until IS NOT NULL AND processing_lease_until <= ?
     LIMIT 100`,
  )
    .bind('processing', nowIso)
    .all<ExpiredProcessingRow>();
  const jobIds = rows.results.map((row) => row.job_id);
  for (const jobId of jobIds) {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE tool_jobs
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
  return updateJobProgress(
    env,
    job,
    { progress, stage: 'storing_page', currentPage: readyPages, totalPages },
    'job.page.ready',
  );
}

export async function updateJobProgress(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  patch: JobProgressPatch,
  eventType: OcrJobEventType = 'job.progress',
): Promise<StoredJob> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE tool_jobs
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
    `UPDATE tool_jobs
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
    `UPDATE tool_jobs
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

export async function setImageCompressResult(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
  output: {
    bytes: ArrayBuffer;
    filename: string;
    mimeType: string;
    originalSizeBytes: number;
    width: number;
    height: number;
    format: ImageCompressFormat;
    quality: number;
    targetSizeBytes?: number;
    targetMet: boolean;
  },
): Promise<StoredJob> {
  const outputR2Key = `${OUTPUT_PREFIX}/${job.clientId}/${job.jobId}/${safeR2Name(output.filename)}`;
  await env.ASSETS.put(outputR2Key, output.bytes, {
    httpMetadata: { contentType: output.mimeType },
    customMetadata: { jobId: job.jobId, clientId: job.clientId, tool: 'image.compress' },
  });

  const sizeBytes = output.bytes.byteLength;
  const resultR2Key = `${RESULT_PREFIX}/${job.clientId}/${job.jobId}.json`;
  const result: ImageCompressResult = {
    jobId: job.jobId,
    status: 'ready',
    tool: 'image.compress',
    output: {
      filename: output.filename,
      mimeType: output.mimeType,
      originalSizeBytes: output.originalSizeBytes,
      sizeBytes,
      compressionRatio: output.originalSizeBytes > 0 ? sizeBytes / output.originalSizeBytes : 0,
      ...(output.targetSizeBytes ? { targetSizeBytes: output.targetSizeBytes } : {}),
      targetMet: output.targetMet,
      width: output.width,
      height: output.height,
      format: output.format,
      quality: output.quality,
      resultUrl: `/v1/jobs/${job.jobId}/output`,
    },
    metadata: job.callbackMetadata ?? {},
  };
  await env.ASSETS.put(resultR2Key, JSON.stringify(result), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { jobId: job.jobId, clientId: job.clientId, tool: 'image.compress' },
  });

  const completedAt = new Date().toISOString();
  const update = await env.DB.prepare(
    `UPDATE tool_jobs
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
  if (!updated) throw new Error('Ready image compression job not found');
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

export async function requeueJobForRetry(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  error: string,
): Promise<StoredJob> {
  const latest = await getJobForProcessing(env, job.jobId);
  if (latest && isCancelRequested(latest)) return completeCancelledJob(env, latest);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE tool_jobs
     SET status = ?, progress = ?, stage = ?, error = ?, processing_started_at = NULL,
         processing_lease_until = NULL, completed_at = NULL, updated_at = ?
     WHERE job_id = ? AND status = ?`,
  )
    .bind('queued', 0, 'queued', error, timestamp, job.jobId, 'processing')
    .run();

  const updated = await getJobForProcessing(env, job.jobId);
  if (!updated) throw new Error('Retryable job not found');
  await appendJobEvent(env, updated, 'job.status');
  return updated;
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
    `UPDATE tool_jobs
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
  const rows = await env.DB.prepare('SELECT * FROM tool_jobs WHERE expires_at <= ? AND status != ? LIMIT 100')
    .bind(now, 'deleted')
    .all<JobRow>();
  let cleaned = 0;
  for (const row of rows.results) {
    const job = mapJob(row);
    await deleteJobObjects(env, job);
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE tool_jobs
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

export { isTerminalJob };
