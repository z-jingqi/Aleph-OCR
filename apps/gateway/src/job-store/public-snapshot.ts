import type { OcrJob } from '@aleph-tools/shared';
import { TERMINAL_STATUSES, type StoredJob } from './schema';

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

export function isTerminalJob(job: StoredJob): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

export function isCancelRequested(job: StoredJob): boolean {
  return job.status === 'cancel_requested' || job.status === 'cancelled';
}
