import { Hono, type Context } from 'hono';
import { Container } from '@cloudflare/containers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  ALEPH_OCR_VERSION,
  ALEPH_TOOLS_VERSION,
  ImageConvertOptionsSchema,
  MAX_PDF_PAGES,
  MAX_SYNC_IMAGE_SIZE_BYTES,
  inferDocumentType,
  isSupportedImageMime,
  type ApiErrorCode,
  type ImageConvertOptions,
  type JobStatus,
  type OcrPage,
  type OcrDocument,
  type OcrResult,
} from '@aleph-tools/shared';
import { requireApiKey, type AuthEnv, type AuthVariables } from './auth';
import {
  claimJobForProcessing,
  completeCancelledJob,
  cleanupExpiredJobs,
  countActiveJobsForClient,
  createJob,
  deleteJob,
  failJob,
  getPageResults,
  getJobByIdempotencyKey,
  getJob,
  getResult,
  getOutputFile,
  getSourceFile,
  initializeJobPages,
  isCancelRequested,
  requestJobCancel,
  setJobPageResult,
  claimJobPage,
  failJobPage,
  listDueWebhookDeliveries,
  listJobEvents,
  markWebhookDelivered,
  markWebhookFailed,
  publicJob,
  requireStorage,
  resetExpiredProcessingJobs,
  setJobResult,
  setImageConvertResult,
  updateJobProgress,
  type StoredJob,
  type WebhookDelivery,
} from './job-store';
import { convertImage, getEngineInfo, getPdfInfo, OcrEngineError, ocrImage, ocrPdfPage, type ToolsClientEnv } from './ocr-client';

export class ToolsEngineContainer extends Container {
  defaultPort = 8090;
  sleepAfter = '10m';
}

interface Env extends AuthEnv, ToolsClientEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  OCR_JOBS?: Queue<QueueMessage>;
  TOOLS_ENGINE?: DurableObjectNamespace<ToolsEngineContainer>;
  TOOLS_WORKFLOW?: Workflow<ToolWorkflowParams>;
  OCR_WORKFLOW?: Workflow<ToolWorkflowParams>;
  JOB_RETENTION_DAYS?: string;
  WEBHOOK_SIGNING_SECRET?: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_ACTIVE_JOBS_PER_CLIENT?: string;
}

type StorageEnv = Env & { DB: D1Database; ASSETS: R2Bucket };
type QueueMessage = { jobId: string };
type ToolWorkflowParams = { jobId: string };
type ErrorStatus = 400 | 401 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 501 | 503;
type WorkflowStepLike = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
};
type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', async (c, next) => {
  const incoming = c.req.header('X-Request-Id')?.trim();
  const requestId = incoming && incoming.length <= 128 ? incoming : `req_${crypto.randomUUID()}`;
  c.set('requestId', requestId);
  await next();
  c.res.headers.set('X-Request-Id', requestId);
});

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'aleph-tools-gateway',
    version: ALEPH_TOOLS_VERSION,
    legacyVersion: ALEPH_OCR_VERSION,
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
  }),
);

app.use('/v1/*', requireApiKey());

app.get('/v1/engines', async (c) => {
  try {
    const engine = await getEngineInfo(c.env);
    return jsonSuccess(c, engine);
  } catch (error) {
    return engineErrorResponse(c, error);
  }
});

app.post('/v1/ocr/sync', async (c) => {
  const parsed = await readUploadedFile(c.req.raw);
  if (!parsed.ok) return parsedUploadError(c, parsed);

  const { file } = parsed;
  if (!isSupportedImageMime(file.type)) {
    return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', 'Sync OCR only supports image files', 400, { retryable: false });
  }
  if (file.size > MAX_SYNC_IMAGE_SIZE_BYTES) {
    return jsonError(c, 'FILE_TOO_LARGE', 'Image exceeds sync OCR size limit', 413, { retryable: false });
  }

  try {
    const result = await ocrImage(c.env, file);
    return jsonSuccess(c, result);
  } catch (error) {
    return engineErrorResponse(c, error);
  }
});

app.post('/v1/tools/image/convert/sync', async (c) => {
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

app.post('/v1/jobs', async (c) => {
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

  const { file, callbackUrl, metadata } = parsed;
  const documentType = inferDocumentType(file.type);
  if (!documentType) {
    return jsonError(c, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file type: ${file.type || 'unknown'}`, 400, { retryable: false });
  }

  const document: OcrDocument = {
    type: documentType,
    filename: file.name || 'upload',
    mimeType: file.type,
    sizeBytes: file.size,
  };

  try {
    const fingerprint = await buildIdempotencyFingerprint(file, 'ocr', 'ocr', {});
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
      return jsonError(c, 'RATE_LIMITED', 'Client active job limit reached', 429, { retryable: true });
    }
    const workflowId = `ocrwf_${crypto.randomUUID()}`;
    const job = await createJob(c.env, c.get('clientId'), document, file, {
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(metadata ? { callbackMetadata: metadata } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      idempotencyFingerprint: fingerprint,
      workflowId,
    });
    await startToolWorkflow(c.env, job.jobId, job.workflowId ?? workflowId);
    return jsonSuccess(c, publicJob(job), 202);
  } catch (error) {
    return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not create OCR job', 500, { retryable: true });
  }
});

app.post('/v1/tools/image/convert', async (c) => {
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
      return jsonError(c, 'RATE_LIMITED', 'Client active job limit reached', 429, { retryable: true });
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
    if (job.status !== 'ready') return jobStateError(c, job, 'result');
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

app.get('/v1/jobs/:jobId/output', async (c) => {
  try {
    requireStorage(c.env);
    const jobId = c.req.param('jobId');
    const job = await getJob(c.env, c.get('clientId'), jobId);
    if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'Job not found', 404, { retryable: false, jobId });
    if (job.status !== 'ready') return jobStateError(c, job, 'output');
    const object = await getOutputFile(c.env, job);
    if (!object) {
      console.error('Ready job output object is missing', JSON.stringify({ requestId: c.get('requestId'), jobId, clientId: c.get('clientId') }));
      return jsonError(c, 'OUTPUT_NOT_FOUND', 'Job output object is missing', 500, {
        retryable: true,
        jobId,
        jobStatus: job.status,
        stage: job.stage,
        terminal: true,
      });
    }
    const output = job.output as { filename?: unknown; mimeType?: unknown } | undefined;
    const filename = typeof output?.filename === 'string' ? output.filename : `${job.jobId}.bin`;
    const mimeType = typeof output?.mimeType === 'string' ? output.mimeType : 'application/octet-stream';
    return new Response(object.body, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${escapeHeaderFilename(filename)}"`,
      },
    });
  } catch (error) {
    return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not read job output', 500, { retryable: true });
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (!message.body?.jobId) throw new Error('Invalid tools queue message');
        await processJob(env, message.body.jobId);
        message.ack();
      } catch (error) {
        console.error('Tools job failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;

export class ToolJobWorkflow extends WorkflowEntrypoint<Env, ToolWorkflowParams> {
  async run(event: Readonly<{ payload: ToolWorkflowParams }>, step: WorkflowStepLike) {
    requireStorage(this.env);
    await runToolWorkflow(this.env, event.payload.jobId, step);
  }
}

export class OcrJobWorkflow extends ToolJobWorkflow {}

export async function processJob(env: Env, jobId: string) {
  requireStorage(env);
  await runToolWorkflow(env, jobId, createInlineWorkflowStep());
}

export async function runToolWorkflow(env: StorageEnv, jobId: string, step: WorkflowStepLike) {
  let job = await step.do(`claim ${jobId}`, async () => claimJobForProcessing(env, jobId));
  if (!job) return;
  try {
    await assertNotCancelled(env, job);
    const claimedJob = job;
    job = await step.do(`read source ${claimedJob.jobId}`, async () => updateJobProgress(env, claimedJob, { progress: 15, stage: 'reading_source' }));
    const sourceJob = job;
    const object = await step.do(`load source ${sourceJob.jobId}`, async () => getSourceFile(env, sourceJob));
    if (!object) throw new Error('Source file is missing');
    const bytes = await object.arrayBuffer();
    const file = new File([bytes], job.document.filename, { type: job.document.mimeType });

    if (job.tool === 'image.convert') {
      await processImageConvertJob(env, step, job, file);
    } else if (job.document.type === 'pdf') {
      await processPdfJob(env, step, job, file);
    } else {
      await processImageJob(env, step, job, file);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown tools job error';
    const latest = (await getJob(env, job.clientId, job.jobId)) ?? job;
    let cancelled = false;
    if (isCancelRequested(latest)) {
      await completeCancelledJob(env, latest);
      cancelled = true;
    } else {
      await failJob(env, latest, message);
    }
    await deliverDueWebhooks(env);
    if (!cancelled && job.attemptCount < maxJobAttempts(env)) throw error;
  }
}

async function processImageJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  job = await step.do(`image progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 50, stage: 'ocr', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const result = await step.do(`ocr image ${job.jobId}`, async () => ocrImage(env, file));
  await assertNotCancelled(env, job);
  job = await step.do(`store image result ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 90, stage: 'storing_result' }));
  await step.do(`ready image ${job.jobId}`, async () => setJobResult(env, job, result));
  await deliverDueWebhooks(env);
}

async function processImageConvertJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  const options = ImageConvertOptionsSchema.parse(job.toolOptions ?? {});
  job = await step.do(`image convert progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 50, stage: 'processing', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const output = await step.do(`convert image ${job.jobId}`, async () => convertImage(env, file, options));
  await assertNotCancelled(env, job);
  job = await step.do(`store image conversion progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 90, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
  );
  await step.do(`ready image conversion ${job.jobId}`, async () => setImageConvertResult(env, job, output));
  await deliverDueWebhooks(env);
}

async function processPdfJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  job = await step.do(`plan pdf ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 20, stage: 'planning_pages' }));
  const info = await step.do(`pdf info ${job.jobId}`, async () => getPdfInfo(env, file));
  if (info.pageCount > MAX_PDF_PAGES) throw new Error(`PDF has ${info.pageCount} pages; max supported pages is ${MAX_PDF_PAGES}`);
  await step.do(`init pages ${job.jobId}`, async () => initializeJobPages(env, job, info.pageCount));
  job = await step.do(`pdf planned ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 25, stage: 'ocr', currentPage: 0, totalPages: info.pageCount }),
  );

  for (let pageIndex = 0; pageIndex < info.pageCount; pageIndex += 1) {
    await assertNotCancelled(env, job);
    const claimed = await step.do(`claim page ${job.jobId} ${pageIndex}`, async () => claimJobPage(env, job, pageIndex));
    if (!claimed) continue;
    try {
      const pageResult = await step.do(`ocr page ${job.jobId} ${pageIndex}`, async () => ocrPdfPage(env, file, pageIndex));
      const page = normalizePageResult(pageResult, pageIndex);
      job = await step.do(`store page ${job.jobId} ${pageIndex}`, async () => setJobPageResult(env, job, page));
    } catch (error) {
      await failJobPage(env, job, pageIndex, error instanceof Error ? error.message : 'Page OCR failed');
      throw error;
    }
  }

  await assertNotCancelled(env, job);
  job = await step.do(`merge pdf progress ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 95, stage: 'storing_result' }));
  const pages = await step.do(`read page results ${job.jobId}`, async () => getPageResults(env, job));
  const result = buildPdfResult(job, pages);
  await step.do(`ready pdf ${job.jobId}`, async () => setJobResult(env, job, result));
  await deliverDueWebhooks(env);
}

async function runScheduledMaintenance(env: Env) {
  try {
    requireStorage(env);
    const requeued = await resetExpiredProcessingJobs(env);
    const queue = env.OCR_JOBS;
    if (queue) {
      await Promise.all(requeued.map((jobId) => queue.send({ jobId })));
    }
    const cleaned = await cleanupExpiredJobs(env);
    await deliverDueWebhooks(env);
    console.log('Tools maintenance complete', JSON.stringify({ cleaned, requeued: requeued.length }));
  } catch (error) {
    console.error('Tools maintenance failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function startToolWorkflow(env: Env, jobId: string, workflowId: string) {
  const workflow = env.TOOLS_WORKFLOW ?? env.OCR_WORKFLOW;
  if (workflow) {
    await workflow.create({
      id: workflowId,
      params: { jobId },
      retention: { successRetention: '7 days', errorRetention: '14 days' },
    });
    return;
  }
  if (!env.OCR_JOBS) throw new Error('Tools workflow is not configured');
  await env.OCR_JOBS.send({ jobId });
}

function workflowConfigured(env: Env): boolean {
  return Boolean(env.TOOLS_WORKFLOW ?? env.OCR_WORKFLOW ?? env.OCR_JOBS);
}

function createInlineWorkflowStep(): WorkflowStepLike {
  return {
    async do<T>(_name: string, configOrCallback: Record<string, unknown> | (() => Promise<T>), maybeCallback?: () => Promise<T>): Promise<T> {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      if (!callback) throw new Error('Workflow step callback is required');
      return callback();
    },
  };
}

async function assertNotCancelled(env: StorageEnv, job: StoredJob) {
  const latest = await getJob(env, job.clientId, job.jobId);
  if (latest && isCancelRequested(latest)) {
    await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled');
  }
}

function normalizePageResult(result: OcrResult, pageIndex: number): OcrPage {
  const page = result.pages[0];
  if (!page) throw new Error(`OCR engine returned no result for page ${pageIndex + 1}`);
  return { ...page, pageIndex };
}

function buildPdfResult(job: StoredJob, pages: OcrPage[]): OcrResult {
  const plainText = pages.map((page) => page.text).filter(Boolean).join('\n\n');
  const markdown = pages
    .map((page) => (page.text ? `## Page ${page.pageIndex + 1}\n\n${page.text}` : ''))
    .filter(Boolean)
    .join('\n\n');
  return {
    status: 'ready',
    engine: 'paddleocr',
    engineVersion: '3.x',
    document: job.document,
    pages,
    plainText,
    markdown,
  };
}

async function readUploadedFile(request: Request): Promise<
  | { ok: true; file: File; callbackUrl?: string; metadata?: Record<string, unknown> }
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

  const callbackUrl = form.get('callbackUrl');
  if (callbackUrl !== null && typeof callbackUrl !== 'string') {
    return { ok: false, status: 400, error: 'callbackUrl must be a string' };
  }
  if (callbackUrl && !isValidHttpUrl(callbackUrl)) {
    return { ok: false, status: 400, error: 'callbackUrl must be an http(s) URL' };
  }

  const metadataField = form.get('metadata');
  if (metadataField !== null && typeof metadataField !== 'string') {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }
  const metadata = metadataField ? parseMetadata(metadataField) : undefined;
  if (metadataField && !metadata) {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }

  return { ok: true, file, ...(callbackUrl ? { callbackUrl } : {}), ...(metadata ? { metadata } : {}) };
}

async function readImageConvertRequest(request: Request): Promise<
  | { ok: true; file: File; options: ImageConvertOptions; callbackUrl?: string; metadata?: Record<string, unknown> }
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

  const callbackUrl = form.get('callbackUrl');
  if (callbackUrl !== null && typeof callbackUrl !== 'string') {
    return { ok: false, status: 400, error: 'callbackUrl must be a string' };
  }
  if (callbackUrl && !isValidHttpUrl(callbackUrl)) {
    return { ok: false, status: 400, error: 'callbackUrl must be an http(s) URL' };
  }

  const metadataField = form.get('metadata');
  if (metadataField !== null && typeof metadataField !== 'string') {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }
  const metadata = metadataField ? parseMetadata(metadataField) : undefined;
  if (metadataField && !metadata) {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }

  const options = parseImageConvertOptions(form);
  if (!options.ok) return options;

  return { ok: true, file, options: options.options, ...(callbackUrl ? { callbackUrl } : {}), ...(metadata ? { metadata } : {}) };
}

function parseImageConvertOptions(form: FormData): { ok: true; options: ImageConvertOptions } | { ok: false; status: 400; error: string } {
  const targetFormat = form.get('targetFormat');
  const quality = form.get('quality');
  const width = form.get('width');
  const height = form.get('height');
  const fit = form.get('fit');
  if (typeof targetFormat !== 'string') return { ok: false, status: 400, error: 'targetFormat is required' };
  const raw = {
    targetFormat,
    ...(quality !== null ? { quality: numberField(quality, 'quality') } : {}),
    ...(width !== null ? { width: numberField(width, 'width') } : {}),
    ...(height !== null ? { height: numberField(height, 'height') } : {}),
    ...(fit !== null ? { fit } : {}),
  };
  if (raw.quality === null) return { ok: false, status: 400, error: 'quality must be a number' };
  if (raw.width === null) return { ok: false, status: 400, error: 'width must be a number' };
  if (raw.height === null) return { ok: false, status: 400, error: 'height must be a number' };
  const parsed = ImageConvertOptionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'Invalid image conversion options' };
  return { ok: true, options: parsed.data };
}

function numberField(value: FormDataEntryValue, name: string): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function jsonSuccess(c: AppContext, data: unknown, status: 200 | 202 = 200): Response {
  return c.json({ success: true, data, requestId: c.get('requestId') }, status);
}

function jsonError(
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
  );
}

function parsedUploadError(
  c: AppContext,
  parsed: { ok: false; status: 400 | 413 | 415; error: string },
): Response {
  const code: ApiErrorCode =
    parsed.status === 413 ? 'FILE_TOO_LARGE' : parsed.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : parsed.error.includes('Unsupported') ? 'UNSUPPORTED_FORMAT' : 'VALIDATION_ERROR';
  return jsonError(c, code, parsed.error, parsed.status, { retryable: false });
}

function jobStateError(c: AppContext, job: StoredJob, target: 'result' | 'output'): Response {
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
  return jsonError(c, 'JOB_NOT_READY', `Job ${target} is not ready; current status is ${job.status}`, 409, {
    retryable: true,
    jobId: job.jobId,
    jobStatus: job.status,
    stage: job.stage,
    terminal: false,
  });
}

function engineErrorResponse(c: AppContext, error: unknown) {
  if (error instanceof OcrEngineError) {
    const status = isErrorStatus(error.status) ? error.status : 503;
    const code: ApiErrorCode =
      status === 413
        ? 'FILE_TOO_LARGE'
        : status === 415
          ? 'UNSUPPORTED_MEDIA_TYPE'
          : status === 501
            ? 'UNSUPPORTED_FORMAT'
            : status >= 500
              ? 'ENGINE_UNAVAILABLE'
              : 'VALIDATION_ERROR';
    return jsonError(c, code, error.message, status, { retryable: status >= 500 && status !== 501 });
  }
  return jsonError(c, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Tools request failed', 500, { retryable: true });
}

function isErrorStatus(status: number): status is ErrorStatus {
  return [400, 401, 404, 409, 410, 413, 415, 422, 429, 500, 501, 503].includes(status);
}

function createJobEventStream(
  env: Env & { DB: D1Database },
  clientId: string,
  jobId: string,
  afterSequence: number,
  once: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let cursor = afterSequence;
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const sendEvent = (event: string, id: number, data: unknown) => {
        send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const job = await getJob(env, clientId, jobId);
      if (!job) {
        controller.close();
        return;
      }
      sendEvent('job.snapshot', cursor, publicJob(job));

      while (true) {
        const events = await listJobEvents(env, clientId, jobId, cursor);
        for (const event of events) {
          cursor = event.sequence;
          sendEvent(event.type, event.sequence, event.payload);
        }
        if (once) {
          controller.close();
          return;
        }
        send(`event: ping\ndata: {"timestamp":"${new Date().toISOString()}"}\n\n`);
        await sleep(15000);
      }
    },
  });
}

async function deliverDueWebhooks(env: Env & { DB: D1Database }) {
  const deliveries = await listDueWebhookDeliveries(env);
  await Promise.all(deliveries.map((delivery) => deliverWebhook(env, delivery)));
}

async function deliverWebhook(env: Env & { DB: D1Database }, delivery: WebhookDelivery) {
  const body = JSON.stringify(delivery.payload);
  const timestamp = new Date().toISOString();
  try {
    const signature = await signWebhook(env, timestamp, body);
    const response = await fetch(new Request(delivery.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aleph-Tools-Event-Id': delivery.eventId,
        'X-Aleph-Tools-Delivery-Id': delivery.deliveryId,
        'X-Aleph-Tools-Timestamp': timestamp,
        'X-Aleph-Tools-Signature': signature,
        'X-Aleph-OCR-Event-Id': delivery.eventId,
        'X-Aleph-OCR-Delivery-Id': delivery.deliveryId,
        'X-Aleph-OCR-Timestamp': timestamp,
        'X-Aleph-OCR-Signature': signature,
      },
      body,
    }));
    if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
    await markWebhookDelivered(env, delivery.deliveryId);
  } catch (error) {
    await markWebhookFailed(env, delivery, error instanceof Error ? error.message : 'Webhook delivery failed');
  }
}

async function signWebhook(env: Env, timestamp: string, body: string): Promise<string> {
  const secret = env.WEBHOOK_SIGNING_SECRET ?? env.ALEPH_TOOLS_API_KEYS ?? env.ALEPH_OCR_API_KEYS ?? 'aleph-tools-local-webhook-secret';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${toHex(signature)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseMetadata(value: string): Record<string, unknown> | null {
  if (value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined | null {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 256) return null;
  return trimmed;
}

async function buildIdempotencyFingerprint(file: File, tool: string, operation: string, options: Record<string, unknown>): Promise<string> {
  const payload = stableStringify({
    filename: file.name || 'upload',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    tool,
    operation,
    options,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${toHex(digest)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function escapeHeaderFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function maxJobAttempts(env: Env): number {
  const parsed = Number(env.MAX_JOB_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

function maxActiveJobsPerClient(env: Env): number | null {
  const raw = env.MAX_ACTIVE_JOBS_PER_CLIENT;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
