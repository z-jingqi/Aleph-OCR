import {
  MAX_SYNC_IMAGE_SIZE_BYTES,
  inferDocumentType,
  isOcrNativeImageFile,
  type OcrDocument,
} from '@aleph-tools/shared';
import { maxActiveJobsPerClient, syncEndpointsEnabled, workflowConfigured } from '../config';
import { normalizeImageUploadFile } from '../http/file-types';
import { buildIdempotencyFingerprint, normalizeIdempotencyKey } from '../http/idempotency';
import { engineErrorResponse, jsonError, jsonSuccess, parsedUploadError } from '../http/responses';
import { readUploadedFile } from '../http/uploads';
import {
  countActiveJobsForClient,
  createJob,
  getJobByIdempotencyKey,
  publicJob,
  requireStorage,
} from '../job-store';
import { ocrImage } from '../ocr-client';
import { startToolWorkflow } from '../workflow/runner';
import { withRequestedOcrModeMetadata } from '../workflow/ocr-result';
import type { GatewayApp } from './types';

export function registerOcrRoutes(app: GatewayApp) {
  app.post('/v1/tools/ocr/sync', async (c) => {
    if (!syncEndpointsEnabled(c.env)) {
      return jsonError(c, 'VALIDATION_ERROR', 'Synchronous OCR is disabled; use async job endpoints', 400, { retryable: false });
    }
    const parsed = await readUploadedFile(c.req.raw);
    if (!parsed.ok) return parsedUploadError(c, parsed);

    const { ocrMode } = parsed;
    const file = normalizeImageUploadFile(parsed.file);
    if (!isOcrNativeImageFile(file.type, file.name)) {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', 'Sync OCR only supports image files', 400, { retryable: false });
    }
    if (file.size > MAX_SYNC_IMAGE_SIZE_BYTES) {
      return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds sync OCR size limit', 413, { retryable: false });
    }

    try {
      const result = withRequestedOcrModeMetadata(await ocrImage(c.env, file, ocrMode), ocrMode);
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

    const { callbackUrl, metadata, ocrMode, pdfExtractionMode } = parsed;
    const documentType = inferDocumentType(parsed.file.type, parsed.file.name);
    if (!documentType) {
      return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file type: ${parsed.file.type || 'unknown'}`, 400, { retryable: false });
    }
    const file = documentType === 'image' ? normalizeImageUploadFile(parsed.file) : parsed.file;

    const document: OcrDocument = {
      type: documentType,
      filename: file.name || 'upload',
      mimeType: file.type,
      sizeBytes: file.size,
    };

    try {
      const ocrOptions = documentType === 'pdf' ? { ocrMode, pdfExtractionMode } : { ocrMode };
      const fingerprint = await buildIdempotencyFingerprint(file, 'ocr', 'ocr', ocrOptions);
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
        tool: 'ocr',
        operation: 'ocr',
        ...(callbackUrl ? { callbackUrl } : {}),
        ...(metadata ? { callbackMetadata: metadata } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        idempotencyFingerprint: fingerprint,
        toolOptions: ocrOptions,
        workflowId,
      });
      await startToolWorkflow(c.env, job.jobId, job.workflowId ?? workflowId);
      return jsonSuccess(c, publicJob(job), 202);
    } catch (error) {
      return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not create OCR job', 500, { retryable: true });
    }
  });
}
