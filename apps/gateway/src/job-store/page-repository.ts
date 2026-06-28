import type { OcrPage } from '@aleph-tools/shared';
import { mapPageIndex } from './mappers';
import {
  PROCESSING_LEASE_SECONDS,
  type JobStoreEnv,
  type PageRow,
  type StoredJob,
} from './schema';
import { hasChangedRows } from './schema';

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
    if (!page.result_r2_key) throw new Error(`Page ${mapPageIndex(page) + 1} result is missing`);
    const object = await env.ASSETS.get(page.result_r2_key);
    if (!object) throw new Error(`Page ${mapPageIndex(page) + 1} result object is missing`);
    results.push(JSON.parse(await object.text()) as OcrPage);
  }
  return results.sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function countReadyPages(env: JobStoreEnv & { DB: D1Database }, jobId: string): Promise<number> {
  const rows = await env.DB.prepare('SELECT * FROM ocr_job_pages WHERE job_id = ? AND status = ?')
    .bind(jobId, 'ready')
    .all<PageRow>();
  return rows.results.length;
}
