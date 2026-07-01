import { MAX_SYNC_IMAGE_SIZE_BYTES, inferDocumentType, type OcrDocument } from '@aleph-tools/shared';
import { maxImageUploadBytes, syncEndpointsEnabled, workflowConfigured } from '../config';
import { validateOcrImageInput } from '../http/file-types';
import { buildIdempotencyFingerprint, normalizeIdempotencyKey } from '../http/idempotency';
import { engineErrorResponse, jsonError, jsonSuccess, parsedUploadError } from '../http/responses';
import { readUploadedFile } from '../http/uploads';
import { abandonUnstartedJob, createJob, getJobByIdempotencyKey, publicJob, requireStorage } from '../job-store';
import { ocrImage } from '../ocr-client';
import { prepareOcrInput } from '../ocr-input';
import { startToolWorkflow } from '../workflow/runner';
import { activeJobLimitResponse } from './job-limits';
import type { GatewayApp } from './types';

export function registerOcrRoutes(app: GatewayApp) {
  app.post('/v1/tools/ocr/sync', async (c) => {
    if (!syncEndpointsEnabled(c.env)) {
      return jsonError(c, 'VALIDATION_ERROR', 'Synchronous OCR is disabled; use async job endpoints', 400, { retryable: false });
    }
    const parsed = await readUploadedFile(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const validationError = validateOcrImageInput(parsed.file);
    if (validationError === 'OCR only accepts image files') {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', validationError, 400, { retryable: false });
    }
    if (validationError) return jsonError(c, 'UNSUPPORTED_FORMAT', validationError, 400, { retryable: false });
    if (parsed.file.size > MAX_SYNC_IMAGE_SIZE_BYTES) {
      return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds sync OCR size limit', 413, { retryable: false });
    }

    try {
      const input = await prepareOcrInput(c.env, parsed.file);
      const result = await ocrImage(c.env, input.file, input);
      return jsonSuccess(c, result);
    } catch (error) {
      return engineErrorResponse(c, error);
    }
  });

  app.post('/v1/tools/ocr', async (c) => {
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

    const parsed = await readUploadedFile(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const documentType = inferDocumentType(parsed.file.type, parsed.file.name);
    if (documentType !== 'image') {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', 'OCR only accepts image files', 400, { retryable: false });
    }
    const validationError = validateOcrImageInput(parsed.file);
    if (validationError === 'OCR only accepts image files') {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', validationError, 400, { retryable: false });
    }
    if (validationError) return jsonError(c, 'UNSUPPORTED_FORMAT', validationError, 400, { retryable: false });
    if (parsed.file.size > maxImageUploadBytes(c.env)) {
      return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds OCR upload size limit', 413, { retryable: false });
    }

    const file = parsed.file;
    const document: OcrDocument = {
      type: 'image',
      filename: file.name || 'image',
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    };

    try {
      const fingerprint = await buildIdempotencyFingerprint(file, 'ocr', 'ocr', {
        provider: 'google-vision',
        feature: 'DOCUMENT_TEXT_DETECTION',
        autoConvert: true,
      });
      if (idempotencyKey) {
        const existing = await getJobByIdempotencyKey(c.env, c.get('clientId'), idempotencyKey);
        if (existing) {
          if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== fingerprint) {
            return jsonError(c, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different job input', 409, { retryable: false });
          }
          return jsonSuccess(c, publicJob(existing), 202);
        }
      }
      const limitResponse = await activeJobLimitResponse(c);
      if (limitResponse) return limitResponse;
      const workflowId = `toolswf_${crypto.randomUUID()}`;
      const job = await createJob(c.env, c.get('clientId'), document, file, {
        tool: 'ocr',
        operation: 'ocr',
        ...(parsed.callbackUrl ? { callbackUrl: parsed.callbackUrl } : {}),
        ...(parsed.metadata ? { callbackMetadata: parsed.metadata } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        idempotencyFingerprint: fingerprint,
        toolOptions: { provider: 'google-vision', feature: 'DOCUMENT_TEXT_DETECTION', autoConvert: true },
        workflowId,
      });
      try {
        await startToolWorkflow(c.env, job.jobId, job.workflowId ?? workflowId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start OCR workflow';
        await abandonUnstartedJob(c.env, job, `Workflow start failed: ${message}`);
        throw error;
      }
      return jsonSuccess(c, publicJob(job), 202);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not create OCR job', 500, { retryable: true });
    }
  });
}
