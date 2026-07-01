import { jsonError, jsonSuccess, jobStateError } from '../http/responses';
import {
  deleteJob,
  getJob,
  getResult,
  getSourceFile,
  publicJob,
  requestJobCancel,
  requireStorage,
  type StoredJob,
} from '../job-store';
import { createJobEventStream } from '../sse';
import type { AppContext } from '../types';
import { deliverDueWebhooks } from '../webhooks';
import type { GatewayApp } from './types';

export function registerJobRoutes(app: GatewayApp) {
  app.post('/v1/jobs/:jobId/cancel', async (c) => {
    try {
      requireStorage(c.env);
      const job = await requestJobCancel(c.env, c.get('clientId'), c.req.param('jobId'));
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId: c.req.param('jobId') });
      await deliverDueWebhooks(c.env);
      return jsonSuccess(c, publicJob(job));
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not cancel job', 500, { retryable: true });
    }
  });

  app.get('/v1/jobs/:jobId', async (c) => {
    try {
      requireStorage(c.env);
      const job = await getJob(c.env, c.get('clientId'), c.req.param('jobId'));
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId: c.req.param('jobId') });
      return jsonSuccess(c, publicJob(job));
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not read job', 500, { retryable: true });
    }
  });

  app.get('/v1/jobs/:jobId/result', async (c) => {
    try {
      requireStorage(c.env);
      const jobId = c.req.param('jobId');
      const job = await getJob(c.env, c.get('clientId'), jobId);
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId });
      if (job.status !== 'ready') return jobStateError(c, job);
      const result = await getResult(c.env, job);
      if (!result) {
        console.error('Ready job result object is missing', JSON.stringify({ requestId: c.get('requestId'), jobId, clientId: c.get('clientId') }));
        return jsonError(c, 'RESULT_NOT_FOUND', 'Job result object is missing', 500, {
          retryable: true,
          jobId,
          jobStatus: job.status,
          stage: job.stage,
          terminal: true,
        });
      }
      return jsonSuccess(c, result);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not read result', 500, { retryable: true });
    }
  });

  app.get('/v1/jobs/:jobId/source', async (c) => {
    try {
      requireStorage(c.env);
      const jobId = c.req.param('jobId');
      const job = await getJob(c.env, c.get('clientId'), jobId);
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId });
      if (job.status === 'deleted') return deletedJobError(c, job);
      const source = await getSourceFile(c.env, job);
      if (!source) return sourceNotFoundError(c, job);

      return new Response(source.body, {
        headers: sourceHeaders(job),
      });
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not read source image', 500, { retryable: true });
    }
  });

  app.get('/v1/jobs/:jobId/events', async (c) => {
    try {
      requireStorage(c.env);
      const clientId = c.get('clientId');
      const jobId = c.req.param('jobId');
      const job = await getJob(c.env, clientId, jobId);
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId });
      const lastEventId = Number(c.req.header('Last-Event-ID') ?? '0');
      const once = c.req.query('once') === '1';
      const stream = createJobEventStream(c.env, clientId, jobId, Number.isFinite(lastEventId) ? lastEventId : 0, once);
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not stream job events', 500, { retryable: true });
    }
  });

  app.delete('/v1/jobs/:jobId', async (c) => {
    try {
      requireStorage(c.env);
      const job = await deleteJob(c.env, c.get('clientId'), c.req.param('jobId'));
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId: c.req.param('jobId') });
      return jsonSuccess(c, job);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not delete job', 500, { retryable: true });
    }
  });
}

function deletedJobError(c: AppContext, job: StoredJob): Response {
  return jsonError(c, 'JOB_DELETED', 'Job has been deleted', 410, {
    retryable: false,
    jobId: job.jobId,
    jobStatus: job.status,
    stage: job.stage,
    terminal: true,
  });
}

function sourceNotFoundError(c: AppContext, job: StoredJob): Response {
  console.error('Job source object is missing', JSON.stringify({ requestId: c.get('requestId'), jobId: job.jobId, clientId: c.get('clientId') }));
  return jsonError(c, 'SOURCE_NOT_FOUND', 'Job source object is missing', 500, {
    retryable: true,
    jobId: job.jobId,
    jobStatus: job.status,
    stage: job.stage,
    terminal: true,
  });
}

function sourceHeaders(job: StoredJob, contentType = job.document.mimeType || 'application/octet-stream', filename = job.document.filename): Headers {
  return new Headers({
    'Content-Type': contentType,
    'Content-Disposition': inlineContentDisposition(filename || 'source'),
    'Cache-Control': 'private, max-age=300',
  });
}

function inlineContentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\r\n]/g, '').trim() || 'source';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'source';
  return `inline; filename="${ascii.slice(0, 180)}"; filename*=UTF-8''${encodeRfc5987(cleaned)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
