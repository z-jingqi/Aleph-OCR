import { jsonError, jsonSuccess, jobStateError } from '../http/responses';
import {
  deleteJob,
  getJob,
  getResult,
  publicJob,
  requestJobCancel,
  requireStorage,
} from '../job-store';
import { createJobEventStream } from '../sse';
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
