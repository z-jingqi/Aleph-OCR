import type { JobStatus, OcrDocument, OcrJob, OcrResult } from '@aleph-ocr/shared';

interface StoredJob extends OcrJob {
  result?: OcrResult;
}

const jobs = new Map<string, StoredJob>();

export function createJob(document: OcrDocument): OcrJob {
  const now = new Date().toISOString();
  const job: StoredJob = {
    jobId: `ocr_${crypto.randomUUID()}`,
    status: 'queued',
    document,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.jobId, job);
  return publicJob(job);
}

export function getJob(jobId: string): OcrJob | null {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

export function getResult(jobId: string): OcrResult | null {
  return jobs.get(jobId)?.result ?? null;
}

export function setJobStatus(jobId: string, status: JobStatus, error?: string): OcrJob | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = status;
  job.updatedAt = new Date().toISOString();
  job.error = error;
  jobs.set(jobId, job);
  return publicJob(job);
}

export function setJobResult(jobId: string, result: OcrResult): OcrJob | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = 'ready';
  job.updatedAt = new Date().toISOString();
  job.result = { ...result, jobId, status: 'ready' };
  job.error = undefined;
  jobs.set(jobId, job);
  return publicJob(job);
}

export function deleteJob(jobId: string): OcrJob | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = 'deleted';
  job.updatedAt = new Date().toISOString();
  job.result = undefined;
  jobs.set(jobId, job);
  return publicJob(job);
}

function publicJob(job: StoredJob): OcrJob {
  return {
    jobId: job.jobId,
    status: job.status,
    document: job.document,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error ? { error: job.error } : {}),
  };
}
