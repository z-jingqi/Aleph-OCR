import type { OcrJobEventType } from '@aleph-tools/shared';
import { mapEvent } from './mappers';
import { publicJob } from './public-snapshot';
import type { EventRow, JobEvent, JobStoreEnv, SequenceRow, StoredJob } from './schema';

export async function appendJobEvent(
  env: JobStoreEnv & { DB: D1Database },
  job: StoredJob,
  type: OcrJobEventType,
  extraPayload: Record<string, unknown> = {},
): Promise<JobEvent> {
  const sequenceRow = await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM tool_job_events WHERE job_id = ?')
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
    `INSERT INTO tool_job_events (event_id, job_id, client_id, sequence, type, payload_json, created_at)
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
    `SELECT * FROM tool_job_events
     WHERE job_id = ? AND client_id = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT 100`,
  )
    .bind(jobId, clientId, afterSequence)
    .all<EventRow>();
  return rows.results.map(mapEvent);
}
