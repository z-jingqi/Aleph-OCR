import type { JobStatus, OcrDocument, OcrJob, OcrResult } from '@aleph-ocr/shared';

export interface JobStoreEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  JOB_RETENTION_DAYS?: string;
}

type JobRow = {
  job_id: string;
  client_id: string;
  status: JobStatus;
  document_json: string;
  source_r2_key: string;
  result_r2_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type StoredJob = OcrJob & {
  clientId: string;
  sourceR2Key: string;
  resultR2Key?: string;
  expiresAt: string;
};

const SOURCE_PREFIX = 'sources';
const RESULT_PREFIX = 'results';

export function requireStorage<T extends JobStoreEnv>(env: T): asserts env is T & { DB: D1Database; ASSETS: R2Bucket } {
  if (!env.DB || !env.ASSETS) throw new Error('D1 and R2 bindings are required');
}

export async function createJob(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  clientId: string,
  document: OcrDocument,
  file: File,
): Promise<StoredJob> {
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
      (job_id, client_id, status, document_json, source_r2_key, result_r2_key, error, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  )
    .bind(jobId, clientId, 'queued', JSON.stringify(document), sourceR2Key, timestamp, timestamp, expiresAt)
    .run();
  return {
    jobId,
    clientId,
    status: 'queued',
    document,
    sourceR2Key,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt,
  };
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

export async function getSourceFile(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<R2ObjectBody | null> {
  return env.ASSETS.get(job.sourceR2Key);
}

export async function getResult(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<OcrResult | null> {
  if (!job.resultR2Key) return null;
  const object = await env.ASSETS.get(job.resultR2Key);
  if (!object) return null;
  return JSON.parse(await object.text()) as OcrResult;
}

export async function setJobStatus(
  env: JobStoreEnv & { DB: D1Database },
  jobId: string,
  status: JobStatus,
  error?: string,
): Promise<void> {
  await env.DB.prepare('UPDATE ocr_jobs SET status = ?, error = ?, updated_at = ? WHERE job_id = ?')
    .bind(status, error ?? null, new Date().toISOString(), jobId)
    .run();
}

export async function setJobResult(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  job: StoredJob,
  result: OcrResult,
): Promise<void> {
  const resultR2Key = `${RESULT_PREFIX}/${job.clientId}/${job.jobId}.json`;
  const readyResult: OcrResult = { ...result, jobId: job.jobId, status: 'ready' };
  await env.ASSETS.put(resultR2Key, JSON.stringify(readyResult), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { jobId: job.jobId, clientId: job.clientId },
  });
  await env.DB.prepare(
    'UPDATE ocr_jobs SET status = ?, result_r2_key = ?, error = NULL, updated_at = ? WHERE job_id = ?',
  )
    .bind('ready', resultR2Key, new Date().toISOString(), job.jobId)
    .run();
}

export async function deleteJob(
  env: JobStoreEnv & { DB: D1Database; ASSETS: R2Bucket },
  clientId: string,
  jobId: string,
): Promise<OcrJob | null> {
  const job = await getJob(env, clientId, jobId);
  if (!job) return null;
  await deleteJobObjects(env, job);
  await env.DB.prepare(
    'UPDATE ocr_jobs SET status = ?, result_r2_key = NULL, updated_at = ? WHERE job_id = ? AND client_id = ?',
  )
    .bind('deleted', new Date().toISOString(), jobId, clientId)
    .run();
  return { ...publicJob(job), status: 'deleted', updatedAt: new Date().toISOString() };
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
    await env.DB.prepare(
      'UPDATE ocr_jobs SET status = ?, result_r2_key = NULL, updated_at = ? WHERE job_id = ?',
    )
      .bind('deleted', new Date().toISOString(), job.jobId)
      .run();
    cleaned += 1;
  }
  return cleaned;
}

export function publicJob(job: StoredJob): OcrJob {
  return {
    jobId: job.jobId,
    status: job.status,
    document: job.document,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error ? { error: job.error } : {}),
  };
}

function mapJob(row: JobRow): StoredJob {
  return {
    jobId: row.job_id,
    clientId: row.client_id,
    status: row.status,
    document: JSON.parse(row.document_json) as OcrDocument,
    sourceR2Key: row.source_r2_key,
    ...(row.result_r2_key ? { resultR2Key: row.result_r2_key } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(row.error ? { error: row.error } : {}),
  };
}

async function deleteJobObjects(env: JobStoreEnv & { ASSETS: R2Bucket }, job: StoredJob): Promise<void> {
  await Promise.all([
    env.ASSETS.delete(job.sourceR2Key),
    ...(job.resultR2Key ? [env.ASSETS.delete(job.resultR2Key)] : []),
  ]);
}

function retentionDays(env: JobStoreEnv): number {
  const parsed = Number(env.JOB_RETENTION_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

function safeR2Name(filename: string): string {
  return filename.replace(/[^\w.\-]+/g, '_') || 'upload';
}
