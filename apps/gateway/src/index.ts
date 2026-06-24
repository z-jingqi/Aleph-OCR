import { Hono } from 'hono';
import {
  ALEPH_OCR_VERSION,
  MAX_SYNC_IMAGE_SIZE_BYTES,
  inferDocumentType,
  isSupportedImageMime,
  type OcrDocument,
} from '@aleph-ocr/shared';
import { requireApiKey, type AuthEnv, type AuthVariables } from './auth';
import {
  cleanupExpiredJobs,
  createJob,
  deleteJob,
  getJob,
  getJobForProcessing,
  getResult,
  getSourceFile,
  publicJob,
  requireStorage,
  setJobResult,
  setJobStatus,
} from './job-store';
import { getEngineInfo, OcrEngineError, ocrImage, ocrPdf, type OcrClientEnv } from './ocr-client';

interface Env extends AuthEnv, OcrClientEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  OCR_JOBS?: Queue<QueueMessage>;
  JOB_RETENTION_DAYS?: string;
}

type QueueMessage = { jobId: string };
type ErrorStatus = 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503;

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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
  if (!c.env.OCR_JOBS) return c.json({ success: false, error: 'OCR queue is not configured' }, 503);
  try {
    requireStorage(c.env);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Storage unavailable' }, 503);
  }

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

  try {
    const job = await createJob(c.env, c.get('clientId'), document, file);
    await c.env.OCR_JOBS.send({ jobId: job.jobId });
    return c.json({ success: true, data: publicJob(job) }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not create OCR job' }, 500);
  }
});

app.get('/v1/jobs/:jobId', async (c) => {
  try {
    requireStorage(c.env);
    const job = await getJob(c.env, c.get('clientId'), c.req.param('jobId'));
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
    return c.json({ success: true, data: publicJob(job) });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not read OCR job' }, 500);
  }
});

app.get('/v1/jobs/:jobId/result', async (c) => {
  try {
    requireStorage(c.env);
    const jobId = c.req.param('jobId');
    const job = await getJob(c.env, c.get('clientId'), jobId);
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
    if (job.status !== 'ready') return c.json({ success: false, error: `Job is ${job.status}` }, 409);
    const result = await getResult(c.env, job);
    if (!result) return c.json({ success: false, error: 'Job result not found' }, 404);
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not read OCR result' }, 500);
  }
});

app.delete('/v1/jobs/:jobId', async (c) => {
  try {
    requireStorage(c.env);
    const job = await deleteJob(c.env, c.get('clientId'), c.req.param('jobId'));
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
    return c.json({ success: true, data: job });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not delete OCR job' }, 500);
  }
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (!message.body?.jobId) throw new Error('Invalid OCR queue message');
        await processJob(env, message.body.jobId);
        message.ack();
      } catch (error) {
        console.error('OCR job failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;

async function processJob(env: Env, jobId: string) {
  requireStorage(env);
  const job = await getJobForProcessing(env, jobId);
  if (!job || job.status === 'deleted' || job.status === 'ready') return;
  await setJobStatus(env, jobId, 'processing');
  try {
    const object = await getSourceFile(env, job);
    if (!object) throw new Error('Source file is missing');
    const bytes = await object.arrayBuffer();
    const file = new File([bytes], job.document.filename, { type: job.document.mimeType });
    const result = job.document.type === 'pdf' ? await ocrPdf(env, file) : await ocrImage(env, file);
    await setJobResult(env, job, result);
  } catch (error) {
    await setJobStatus(env, jobId, 'failed', error instanceof Error ? error.message : 'Unknown OCR error');
    throw error;
  }
}

async function runCleanup(env: Env) {
  try {
    requireStorage(env);
    const cleaned = await cleanupExpiredJobs(env);
    console.log('OCR cleanup complete', JSON.stringify({ cleaned }));
  } catch (error) {
    console.error('OCR cleanup failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
