import { Hono } from 'hono';
import {
  ALEPH_OCR_VERSION,
  MAX_SYNC_IMAGE_SIZE_BYTES,
  inferDocumentType,
  isSupportedImageMime,
  type OcrDocument,
} from '@aleph-ocr/shared';
import { requireApiKey, type AuthEnv } from './auth';
import { createJob, deleteJob, getJob, getResult, setJobResult, setJobStatus } from './job-store';
import { getEngineInfo, OcrEngineError, ocrImage, ocrPdf, type OcrClientEnv } from './ocr-client';

interface Env extends AuthEnv, OcrClientEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  OCR_JOBS?: Queue;
}

type ErrorStatus = 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503;

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'aleph-ocr-gateway',
    version: ALEPH_OCR_VERSION,
    timestamp: new Date().toISOString(),
  }),
);

app.use('/v1/*', requireApiKey());

app.get('/v1/engines', async (c) => {
  try {
    const engine = await getEngineInfo(c.env);
    return c.json({ success: true, data: engine });
  } catch (error) {
    return engineErrorResponse(c, error);
  }
});

app.post('/v1/ocr/sync', async (c) => {
  const parsed = await readUploadedFile(c.req.raw);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, parsed.status);

  const { file } = parsed;
  if (!isSupportedImageMime(file.type)) {
    return c.json({ success: false, error: 'Sync OCR only supports image files' }, 400);
  }
  if (file.size > MAX_SYNC_IMAGE_SIZE_BYTES) {
    return c.json({ success: false, error: 'Image exceeds sync OCR size limit' }, 413);
  }

  try {
    const result = await ocrImage(c.env, file);
    return c.json({ success: true, data: result });
  } catch (error) {
    return engineErrorResponse(c, error);
  }
});

app.post('/v1/jobs', async (c) => {
  const parsed = await readUploadedFile(c.req.raw);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, parsed.status);

  const { file } = parsed;
  const documentType = inferDocumentType(file.type);
  if (!documentType) {
    return c.json({ success: false, error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
  }

  const document: OcrDocument = {
    type: documentType,
    filename: file.name || 'upload',
    mimeType: file.type,
    sizeBytes: file.size,
  };
  const job = createJob(document);

  c.executionCtx.waitUntil(processJob(c.env, job.jobId, file, document.type));
  return c.json({ success: true, data: job }, 202);
});

app.get('/v1/jobs/:jobId', (c) => {
  const job = getJob(c.req.param('jobId'));
  if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
  return c.json({ success: true, data: job });
});

app.get('/v1/jobs/:jobId/result', (c) => {
  const jobId = c.req.param('jobId');
  const job = getJob(jobId);
  if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
  if (job.status !== 'ready') return c.json({ success: false, error: `Job is ${job.status}` }, 409);
  const result = getResult(jobId);
  if (!result) return c.json({ success: false, error: 'Job result not found' }, 404);
  return c.json({ success: true, data: result });
});

app.delete('/v1/jobs/:jobId', (c) => {
  const job = deleteJob(c.req.param('jobId'));
  if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
  return c.json({ success: true, data: job });
});

export default app;

async function processJob(env: Env, jobId: string, file: File, type: 'image' | 'pdf') {
  setJobStatus(jobId, 'processing');
  try {
    const result = type === 'pdf' ? await ocrPdf(env, file) : await ocrImage(env, file);
    setJobResult(jobId, { ...result, jobId, status: 'ready' });
  } catch (error) {
    setJobStatus(jobId, 'failed', error instanceof Error ? error.message : 'Unknown OCR error');
  }
}

async function readUploadedFile(request: Request): Promise<
  | { ok: true; file: File }
  | { ok: false; status: 400 | 413 | 415; error: string }
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return { ok: false, status: 415, error: 'Expected multipart/form-data' };
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return { ok: false, status: 400, error: 'Please upload a file in the "file" field' };
  }
  return { ok: true, file };
}

function engineErrorResponse(c: { json: (data: unknown, status?: ErrorStatus) => Response }, error: unknown) {
  if (error instanceof OcrEngineError) {
    const status = isErrorStatus(error.status) ? error.status : 503;
    return c.json({ success: false, error: error.message }, status);
  }
  return c.json({ success: false, error: error instanceof Error ? error.message : 'OCR request failed' }, 500);
}

function isErrorStatus(status: number): status is ErrorStatus {
  return [400, 401, 404, 409, 413, 415, 500, 503].includes(status);
}
