import {
  MAX_SYNC_IMAGE_SIZE_BYTES,
  isSupportedImageMime,
  type OcrDocument,
} from '@aleph-tools/shared';
import { legacyImageEndpointsEnabled, maxActiveJobsPerClient, syncEndpointsEnabled, workflowConfigured } from '../config';
import { escapeHeaderFilename } from '../http/headers';
import { buildIdempotencyFingerprint, normalizeIdempotencyKey } from '../http/idempotency';
import { engineErrorResponse, jsonError, jsonSuccess, parsedUploadError } from '../http/responses';
import { readImageConvertRequest } from '../http/uploads';
import {
  countActiveJobsForClient,
  createJob,
  getJobByIdempotencyKey,
  publicJob,
  requireStorage,
} from '../job-store';
import { convertImage } from '../ocr-client';
import { startToolWorkflow } from '../workflow/runner';
import type { GatewayApp } from './types';

export function registerImageConvertRoutes(app: GatewayApp) {
  app.post('/v1/tools/image/convert/sync', async (c) => {
    if (!syncEndpointsEnabled(c.env)) {
      return jsonError(c, 'VALIDATION_ERROR', 'Synchronous image conversion is disabled; use /v1/tools/image/pipeline', 400, { retryable: false });
    }
    const parsed = await readImageConvertRequest(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const { file, options } = parsed;
    if (!isSupportedImageMime(file.type)) {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', 'Image conversion only supports image files', 400, { retryable: false });
    }
    if (file.size > MAX_SYNC_IMAGE_SIZE_BYTES) {
      return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds sync conversion size limit', 413, { retryable: false });
    }

    try {
      const output = await convertImage(c.env, file, options);
      return new Response(output.bytes, {
        headers: {
          'Content-Type': output.mimeType,
          'Content-Length': String(output.bytes.byteLength),
          'Content-Disposition': `attachment; filename="${escapeHeaderFilename(output.filename)}"`,
        },
      });
    } catch (error) {
      return engineErrorResponse(c, error);
    }
  });

  app.post('/v1/tools/image/convert', async (c) => {
    if (!legacyImageEndpointsEnabled(c.env)) {
      return jsonError(c, 'VALIDATION_ERROR', 'Standalone image conversion jobs are disabled; use /v1/tools/image/pipeline', 400, { retryable: false });
    }
    if (!workflowConfigured(c.env)) return jsonError(c, 'WORKFLOW_UNAVAILABLE', 'Tools workflow is not configured', 503, { retryable: true });
    try {
      requireStorage(c.env);
    } catch (error) {
      return jsonError(c, 'STORAGE_UNAVAILABLE', error instanceof Error ? error.message : 'Storage unavailable', 503, { retryable: true });
    }

    const idempotencyKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    if (idempotencyKey === null) {
      return jsonError(c, 'VALIDATION_ERROR', 'Idempotency-Key must be 256 characters or fewer', 400, { retryable: false });
    }

    const parsed = await readImageConvertRequest(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const { file, options, callbackUrl, metadata } = parsed;
    if (!isSupportedImageMime(file.type)) {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported image type: ${file.type || 'unknown'}`, 400, { retryable: false });
    }

    const document: OcrDocument = {
      type: 'image',
      filename: file.name || 'image',
      mimeType: file.type,
      sizeBytes: file.size,
    };

    try {
      const fingerprint = await buildIdempotencyFingerprint(file, 'image.convert', 'image.convert', options);
      if (idempotencyKey) {
        const existing = await getJobByIdempotencyKey(c.env, c.get('clientId'), idempotencyKey);
        if (existing) {
          if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== fingerprint) {
            return jsonError(c, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different job input', 409, { retryable: false });
          }
          return jsonSuccess(c, publicJob(existing), 202);
        }
      }
      const activeLimit = maxActiveJobsPerClient(c.env);
      if (activeLimit !== null && (await countActiveJobsForClient(c.env, c.get('clientId'))) >= activeLimit) {
        return jsonError(c, 'RATE_LIMITED', 'Client active job limit reached', 429, { retryable: true, headers: { 'Retry-After': '30' } });
      }
      const workflowId = `toolswf_${crypto.randomUUID()}`;
      const job = await createJob(c.env, c.get('clientId'), document, file, {
        tool: 'image.convert',
        operation: 'image.convert',
        toolOptions: options,
        ...(callbackUrl ? { callbackUrl } : {}),
        ...(metadata ? { callbackMetadata: metadata } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        idempotencyFingerprint: fingerprint,
        workflowId,
      });
      await startToolWorkflow(c.env, job.jobId, job.workflowId ?? workflowId);
      return jsonSuccess(c, publicJob(job), 202);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not create image conversion job', 500, { retryable: true });
    }
  });
}
