import { type ApiErrorCode, type JobStatus } from '@aleph-tools/shared';
import { OcrEngineError } from '../engine-errors';
import type { StoredJob } from '../job-store';
import type { AppContext } from '../types';
import type { UploadParseError } from './uploads';

type ErrorStatus = 400 | 401 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 501 | 503;

export function jsonSuccess(c: AppContext, data: unknown, status: 200 | 202 = 200): Response {
  return c.json({ success: true, data, requestId: c.get('requestId') }, status);
}

export function jsonError(
  c: AppContext,
  code: ApiErrorCode,
  message: string,
  httpStatus: ErrorStatus,
  options: {
    retryable: boolean;
    terminal?: boolean;
    jobId?: string;
    jobStatus?: JobStatus;
    stage?: string;
    headers?: Record<string, string>;
  },
): Response {
  const terminal = options.terminal ?? (options.jobStatus ? ['ready', 'failed', 'cancelled', 'deleted'].includes(options.jobStatus) : false);
  return c.json(
    {
      success: false,
      error: {
        code,
        message,
        httpStatus,
        requestId: c.get('requestId'),
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.jobStatus ? { jobStatus: options.jobStatus } : {}),
        ...(options.stage ? { stage: options.stage } : {}),
        retryable: options.retryable,
        terminal,
      },
      requestId: c.get('requestId'),
    },
    httpStatus,
    options.headers,
  );
}

export function parsedUploadError(
  c: AppContext,
  parsed: UploadParseError,
): Response {
  const code: ApiErrorCode =
    parsed.status === 413 ? 'FILE_TOO_LARGE' : parsed.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : parsed.error.startsWith('Unsupported image format') ? 'UNSUPPORTED_FORMAT' : 'VALIDATION_ERROR';
  return jsonError(c, code, parsed.error, parsed.status, { retryable: false });
}

export function jobStateError(c: AppContext, job: StoredJob): Response {
  if (job.status === 'deleted') {
    return jsonError(c, 'JOB_DELETED', 'Job has been deleted', 410, {
      retryable: false,
      jobId: job.jobId,
      jobStatus: job.status,
      stage: job.stage,
      terminal: true,
    });
  }
  if (job.status === 'failed') {
    return jsonError(c, 'JOB_FAILED', job.error ?? 'Job failed', 409, {
      retryable: false,
      jobId: job.jobId,
      jobStatus: job.status,
      stage: job.stage,
      terminal: true,
    });
  }
  if (job.status === 'cancelled') {
    return jsonError(c, 'JOB_CANCELLED', 'Job was cancelled', 409, {
      retryable: false,
      jobId: job.jobId,
      jobStatus: job.status,
      stage: job.stage,
      terminal: true,
    });
  }
  return jsonError(c, 'JOB_NOT_READY', `Job result is not ready; current status is ${job.status}`, 409, {
    retryable: true,
    jobId: job.jobId,
    jobStatus: job.status,
    stage: job.stage,
    terminal: false,
  });
}

export function engineErrorResponse(c: AppContext, error: unknown) {
  if (error instanceof OcrEngineError) {
    const status = isErrorStatus(error.status) ? error.status : 503;
    return jsonError(c, error.code, error.message, status, { retryable: error.retryable });
  }
  return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Tools request failed', 500, { retryable: true });
}

function isErrorStatus(status: number): status is ErrorStatus {
  return [400, 401, 404, 409, 410, 413, 415, 422, 429, 500, 501, 503].includes(status);
}
