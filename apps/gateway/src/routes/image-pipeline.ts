import {
  isSupportedImageMime,
  type OcrDocument,
} from '@aleph-tools/shared';
import { maxActiveJobsPerClient, maxImageUploadBytes } from '../config';
import { buildIdempotencyFingerprint, normalizeIdempotencyKey } from '../http/idempotency';
import { jsonError, jsonSuccess, parsedUploadError } from '../http/responses';
import { readImagePipelineRequest } from '../http/uploads';
import {
  countActiveJobsForClient,
  createJob,
  getJobByIdempotencyKey,
  publicJob,
  requireStorage,
} from '../job-store';
import { startQueuedToolJob } from '../workflow/runner';
import type { GatewayApp } from './types';

export function registerImagePipelineRoutes(app: GatewayApp) {
  app.post('/v1/tools/image/pipeline', async (c) => {
    if (!c.env.TOOLS_JOBS) return jsonError(c, 'WORKFLOW_UNAVAILABLE', 'Tools queue is not configured', 503, { retryable: true });
    try {
      requireStorage(c.env);
    } catch (error) {
      return jsonError(c, 'STORAGE_UNAVAILABLE', error instanceof Error ? error.message : 'Storage unavailable', 503, { retryable: true });
    }

    const idempotencyKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    if (!idempotencyKey) {
      return jsonError(c, 'VALIDATION_ERROR', 'Idempotency-Key is required for image pipeline jobs', 400, { retryable: false });
    }

    const parsed = await readImagePipelineRequest(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const { file, options, callbackUrl, metadata } = parsed;
    if (!isSupportedImageMime(file.type)) {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported image type: ${file.type || 'unknown'}`, 400, { retryable: false });
    }
    if (file.size > maxImageUploadBytes(c.env)) {
      return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds pipeline upload size limit', 413, { retryable: false });
    }

    const document: OcrDocument = {
      type: 'image',
      filename: file.name || 'image',
      mimeType: file.type,
      sizeBytes: file.size,
    };

    try {
      const fingerprint = await buildIdempotencyFingerprint(file, 'image.pipeline', 'image.pipeline', options);
      const existing = await getJobByIdempotencyKey(c.env, c.get('clientId'), idempotencyKey);
      if (existing) {
        if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== fingerprint) {
          return jsonError(c, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different job input', 409, { retryable: false });
        }
        return jsonSuccess(c, publicJob(existing), 202);
      }

      const activeLimit = maxActiveJobsPerClient(c.env);
      if (activeLimit !== null && (await countActiveJobsForClient(c.env, c.get('clientId'))) >= activeLimit) {
        return jsonError(c, 'RATE_LIMITED', 'Client active job limit reached', 429, {
          retryable: true,
          headers: { 'Retry-After': '30' },
        });
      }

      const job = await createJob(c.env, c.get('clientId'), document, file, {
        tool: 'image.pipeline',
        operation: 'image.pipeline',
        toolOptions: options,
        ...(callbackUrl ? { callbackUrl } : {}),
        ...(metadata ? { callbackMetadata: metadata } : {}),
        idempotencyKey,
        idempotencyFingerprint: fingerprint,
      });
      await startQueuedToolJob(c.env, job.jobId);
      return jsonSuccess(c, publicJob(job), 202);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not create image pipeline job', 500, { retryable: true });
    }
  });
}
