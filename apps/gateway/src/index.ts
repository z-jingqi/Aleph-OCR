import { Hono } from 'hono';
import {
  ALEPH_OCR_VERSION,
  MAX_PDF_PAGES,
  MAX_SYNC_IMAGE_SIZE_BYTES,
  inferDocumentType,
  isSupportedImageMime,
  type OcrPage,
  type OcrDocument,
  type OcrResult,
} from '@aleph-ocr/shared';
import { requireApiKey, type AuthEnv, type AuthVariables } from './auth';
import {
  claimJobForProcessing,
  completeCancelledJob,
  cleanupExpiredJobs,
  createJob,
  deleteJob,
  failJob,
  getPageResults,
  getJobByIdempotencyKey,
  getJob,
  getResult,
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
  updateJobProgress,
  type StoredJob,
  type WebhookDelivery,
} from './job-store';
import { getEngineInfo, getPdfInfo, OcrEngineError, ocrImage, ocrPdfPage, type OcrClientEnv } from './ocr-client';

interface Env extends AuthEnv, OcrClientEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  OCR_JOBS?: Queue<QueueMessage>;
  OCR_WORKFLOW?: Workflow<OcrWorkflowParams>;
  JOB_RETENTION_DAYS?: string;
  WEBHOOK_SIGNING_SECRET?: string;
  MAX_JOB_ATTEMPTS?: string;
}

type StorageEnv = Env & { DB: D1Database; ASSETS: R2Bucket };
type QueueMessage = { jobId: string };
type OcrWorkflowParams = { jobId: string };
type ErrorStatus = 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503;
type WorkflowStepLike = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
};

const WorkflowEntrypointBase = ((globalThis as unknown as { WorkflowEntrypoint?: new () => { env: Env } }).WorkflowEntrypoint ??
  class {
    env!: Env;
  }) as new () => { env: Env };

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
  if (!c.env.OCR_WORKFLOW && !c.env.OCR_JOBS) return c.json({ success: false, error: 'OCR workflow is not configured' }, 503);
  try {
    requireStorage(c.env);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Storage unavailable' }, 503);
  }

  const idempotencyKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
  if (idempotencyKey === null) {
    return c.json({ success: false, error: 'Idempotency-Key must be 256 characters or fewer' }, 400);
  }
  if (idempotencyKey) {
    const existing = await getJobByIdempotencyKey(c.env, c.get('clientId'), idempotencyKey);
    if (existing) return c.json({ success: true, data: publicJob(existing) }, 202);
  }

  const parsed = await readUploadedFile(c.req.raw);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, parsed.status);

  const { file, callbackUrl, metadata } = parsed;
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
    const workflowId = `ocrwf_${crypto.randomUUID()}`;
    const job = await createJob(c.env, c.get('clientId'), document, file, {
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(metadata ? { callbackMetadata: metadata } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      workflowId,
    });
    await startOcrWorkflow(c.env, job.jobId, job.workflowId ?? workflowId);
    return c.json({ success: true, data: publicJob(job) }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not create OCR job' }, 500);
  }
});

app.post('/v1/jobs/:jobId/cancel', async (c) => {
  try {
    requireStorage(c.env);
    const job = await requestJobCancel(c.env, c.get('clientId'), c.req.param('jobId'));
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
    await deliverDueWebhooks(c.env);
    return c.json({ success: true, data: publicJob(job) });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not cancel OCR job' }, 500);
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

app.get('/v1/jobs/:jobId/events', async (c) => {
  try {
    requireStorage(c.env);
    const clientId = c.get('clientId');
    const jobId = c.req.param('jobId');
    const job = await getJob(c.env, clientId, jobId);
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
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
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Could not stream OCR events' }, 500);
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
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;

export class OcrJobWorkflow extends WorkflowEntrypointBase {
  async run(event: Readonly<{ payload: OcrWorkflowParams }>, step: WorkflowStepLike) {
    requireStorage(this.env);
    await runOcrWorkflow(this.env, event.payload.jobId, step);
  }
}

export async function processJob(env: Env, jobId: string) {
  requireStorage(env);
  await runOcrWorkflow(env, jobId, createInlineWorkflowStep());
}

export async function runOcrWorkflow(env: StorageEnv, jobId: string, step: WorkflowStepLike) {
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

    if (job.document.type === 'pdf') {
      await processPdfJob(env, step, job, file);
    } else {
      await processImageJob(env, step, job, file);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OCR error';
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
    if (env.OCR_JOBS) {
      await Promise.all(requeued.map((jobId) => env.OCR_JOBS!.send({ jobId })));
    }
    const cleaned = await cleanupExpiredJobs(env);
    await deliverDueWebhooks(env);
    console.log('OCR maintenance complete', JSON.stringify({ cleaned, requeued: requeued.length }));
  } catch (error) {
    console.error('OCR maintenance failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function startOcrWorkflow(env: Env, jobId: string, workflowId: string) {
  if (env.OCR_WORKFLOW) {
    await env.OCR_WORKFLOW.create({
      id: workflowId,
      params: { jobId },
      retention: { successRetention: '7 days', errorRetention: '14 days' },
    });
    return;
  }
  if (!env.OCR_JOBS) throw new Error('OCR workflow is not configured');
  await env.OCR_JOBS.send({ jobId });
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
  const secret = env.WEBHOOK_SIGNING_SECRET ?? env.ALEPH_OCR_API_KEYS ?? 'aleph-ocr-local-webhook-secret';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
