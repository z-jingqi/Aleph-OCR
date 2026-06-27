import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JobRow = {
  job_id: string;
  client_id: string;
  status: string;
  progress: number;
  stage: string | null;
  current_page: number | null;
  total_pages: number | null;
  document_json: string;
  source_r2_key: string;
  result_r2_key: string | null;
  error: string | null;
  attempt_count: number;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  callback_url: string | null;
  callback_metadata_json: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  workflow_id: string | null;
  cancelled_at: string | null;
  tool: string;
  operation: string | null;
  tool_options_json: string | null;
  output_r2_key: string | null;
  output_json: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type PageRow = {
  job_id: string;
  client_id: string;
  page_index: number;
  status: string;
  attempt_count: number;
  result_r2_key: string | null;
  error: string | null;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  event_id: string;
  job_id: string;
  client_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
};

type DeliveryRow = {
  delivery_id: string;
  event_id: string;
  job_id: string;
  client_id: string;
  callback_url: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type FakeGatewayEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  OCR_JOBS: Queue<{ jobId: string }>;
  OCR_WORKFLOW?: Workflow<{ jobId: string }>;
  TOOLS_WORKFLOW?: Workflow<{ jobId: string }>;
  ALEPH_TOOLS_API_KEYS: string;
  ALEPH_OCR_API_KEYS: string;
  ALEPH_TOOLS_ENGINE_URL: string;
  OCR_ENGINE_URL: string;
  WEBHOOK_SIGNING_SECRET: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_ACTIVE_JOBS_PER_CLIENT?: string;
  rows: Map<string, JobRow>;
  events: EventRow[];
  deliveries: Map<string, DeliveryRow>;
  pages: PageRow[];
  objects: Map<string, Uint8Array | string>;
  queueMessages: Array<{ jobId: string }>;
  workflowCreates: Array<{ id?: string; params?: { jobId: string } }>;
  failJsonResultPut: boolean;
};

export function fakeEnv(overrides: Partial<FakeGatewayEnv> = {}): FakeGatewayEnv {
  const rows = new Map<string, JobRow>();
  const events: EventRow[] = [];
  const deliveries = new Map<string, DeliveryRow>();
  const pages: PageRow[] = [];
  const objects = new Map<string, Uint8Array | string>();
  const queueMessages: Array<{ jobId: string }> = [];
  const workflowCreates: Array<{ id?: string; params?: { jobId: string } }> = [];
  const env = {
    DB: undefined as unknown as D1Database,
    ASSETS: undefined as unknown as R2Bucket,
    OCR_JOBS: {
      async send(message: { jobId: string }) {
        queueMessages.push(message);
      },
    } as unknown as Queue<{ jobId: string }>,
    ALEPH_TOOLS_API_KEYS: '{"example-client-dev":"dev-key","other-client":"other-key"}',
    ALEPH_OCR_API_KEYS: '{"example-client-dev":"dev-key","other-client":"other-key"}',
    ALEPH_TOOLS_ENGINE_URL: 'https://engine.test',
    OCR_ENGINE_URL: 'https://engine.test',
    WEBHOOK_SIGNING_SECRET: 'test-webhook-secret',
    rows,
    events,
    deliveries,
    pages,
    objects,
    queueMessages,
    workflowCreates,
    failJsonResultPut: false,
    ...overrides,
  };
  env.DB = {
    prepare(sql: string) {
      return new FakeStatement(env, sql);
    },
  } as unknown as D1Database;
  env.ASSETS = {
    async put(key: string, value: string | ReadableStream | ArrayBuffer, options?: R2PutOptions) {
      if (env.failJsonResultPut && options?.httpMetadata?.contentType === 'application/json') {
        throw new Error('R2 result write failed');
      }
      objects.set(key, await normalizeR2Value(value));
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return typeof value === 'string' ? value : new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        },
        body: typeof value === 'string' ? new Blob([value]).stream() : new Blob([value]).stream(),
      } as R2ObjectBody;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? '';
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  } as unknown as R2Bucket;
  (env as FakeGatewayEnv & { TOOLS_WORKFLOW?: Workflow<{ jobId: string }> }).TOOLS_WORKFLOW = {
    async create(options: { id?: string; params?: { jobId: string } }) {
      workflowCreates.push(options);
      return {} as WorkflowInstance;
    },
  } as unknown as Workflow<{ jobId: string }>;
  (env as FakeGatewayEnv & { OCR_WORKFLOW?: Workflow<{ jobId: string }> }).OCR_WORKFLOW = env.TOOLS_WORKFLOW;
  return env;
}

export async function fixtureFile(relativePath: string, mimeType: string): Promise<File> {
  const absolute = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', relativePath);
  const bytes = await readFile(absolute);
  return new File([bytes], relativePath.split('/').at(-1) ?? 'fixture', { type: mimeType });
}

export function sampleOcrResult(document = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 }) {
  return {
    engine: 'mock',
    engineVersion: '1',
    document,
    pages: [{ pageIndex: 0, width: 100, height: 100, text: 'Aleph OCR result', blocks: [], tables: [], confidence: 0.95 }],
    plainText: 'Aleph OCR result',
    markdown: 'Aleph OCR result',
  };
}

class FakeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly env: FakeGatewayEnv,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async first<T>() {
    return this.selectRows()[0] as T | null;
  }

  async all<T>() {
    return { results: this.selectRows() as T[] };
  }

  async run() {
    const sql = normalizeSql(this.sql);
    let changes = 0;
    if (sql.includes('insert into ocr_jobs')) changes = this.insertJob();
    else if (sql.includes('update ocr_jobs') && sql.includes('attempt_count = attempt_count + 1')) changes = this.claimJob();
    else if (sql.includes('update ocr_jobs') && sql.includes('workflow_id = ?')) changes = this.attachWorkflow();
    else if (sql.includes('update ocr_jobs') && sql.includes('cancelled_at = ?')) changes = this.requestCancel();
    else if (sql.includes('update ocr_jobs') && sql.includes('coalesce(cancelled_at')) changes = this.completeCancel();
    else if (sql.includes('update ocr_jobs') && sql.includes('completed_at = null') && sql.includes('where job_id = ? and status = ?')) changes = this.requeueJobForRetry();
    else if (sql.includes('update ocr_jobs') && sql.includes('where job_id = ? and status = ?')) changes = this.resetExpiredJob();
    else if (sql.includes('update ocr_jobs') && sql.includes('coalesce')) changes = this.updateProgress();
    else if (sql.includes('update ocr_jobs') && sql.includes('result_r2_key = ?')) changes = this.setReady();
    else if (sql.includes('update ocr_jobs') && sql.includes('result_r2_key = null')) changes = this.setDeleted();
    else if (sql.includes('insert or ignore into ocr_job_pages')) changes = this.insertPage();
    else if (sql.includes('update ocr_job_pages') && sql.includes('attempt_count = attempt_count + 1')) changes = this.claimPage();
    else if (sql.includes('update ocr_job_pages') && sql.includes('result_r2_key = ?')) changes = this.setPageReady();
    else if (sql.includes('update ocr_job_pages') && sql.includes('error = ?')) changes = this.setPageFailed();
    else if (sql.includes('insert into ocr_job_events')) changes = this.insertEvent();
    else if (sql.includes('insert into ocr_webhook_deliveries')) changes = this.insertDelivery();
    else if (sql.includes('update ocr_webhook_deliveries') && sql.includes('status = ?') && sql.includes('next_attempt_at = null')) changes = this.markDelivered();
    else if (sql.includes('update ocr_webhook_deliveries') && sql.includes('next_attempt_at = ?')) changes = this.markFailed();
    return { success: true, meta: { changes, rows_written: changes } };
  }

  private insertJob() {
    const [
      jobId,
      clientId,
      status,
      progress,
      stage,
      documentJson,
      sourceR2Key,
      callbackUrl,
      callbackMetadataJson,
      idempotencyKey,
      idempotencyFingerprint,
      workflowId,
      tool,
      operation,
      toolOptionsJson,
      createdAt,
      updatedAt,
      expiresAt,
    ] = this.params;
    this.env.rows.set(jobId as string, {
      job_id: jobId as string,
      client_id: clientId as string,
      status: status as string,
      progress: progress as number,
      stage: stage as string,
      current_page: null,
      total_pages: null,
      document_json: documentJson as string,
      source_r2_key: sourceR2Key as string,
      result_r2_key: null,
      error: null,
      attempt_count: 0,
      processing_started_at: null,
      processing_lease_until: null,
      callback_url: callbackUrl as string | null,
      callback_metadata_json: callbackMetadataJson as string | null,
      idempotency_key: idempotencyKey as string | null,
      idempotency_fingerprint: idempotencyFingerprint as string | null,
      workflow_id: workflowId as string | null,
      cancelled_at: null,
      tool: (tool as string | null) ?? 'ocr',
      operation: operation as string | null,
      tool_options_json: toolOptionsJson as string | null,
      output_r2_key: null,
      output_json: null,
      completed_at: null,
      created_at: createdAt as string,
      updated_at: updatedAt as string,
      expires_at: expiresAt as string,
    });
    return 1;
  }

  private attachWorkflow() {
    const [workflowId, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.workflow_id) return 0;
    row.workflow_id = workflowId as string;
    row.updated_at = updatedAt as string;
    return 1;
  }

  private claimJob() {
    const [status, progress, stage, startedAt, leaseUntil, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || !['queued', 'failed'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error: null,
      attempt_count: row.attempt_count + 1,
      processing_started_at: startedAt,
      processing_lease_until: leaseUntil,
      updated_at: updatedAt,
    });
    return 1;
  }

  private resetExpiredJob() {
    const [status, progress, stage, error, updatedAt, jobId, expectedStatus] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.status !== expectedStatus) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error,
      processing_started_at: null,
      processing_lease_until: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private requeueJobForRetry() {
    const [status, progress, stage, error, updatedAt, jobId, expectedStatus] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.status !== expectedStatus) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private requestCancel() {
    const [status, progress, stage, cancelledAt, completedAt, updatedAt, jobId, clientId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.client_id !== clientId || ['ready', 'failed', 'cancelled', 'deleted'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      processing_started_at: null,
      processing_lease_until: null,
      cancelled_at: cancelledAt,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private completeCancel() {
    const [status, progress, stage, cancelledAt, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || !['cancel_requested', 'processing', 'queued'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      processing_started_at: null,
      processing_lease_until: null,
      cancelled_at: row.cancelled_at ?? (cancelledAt as string),
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private updateProgress() {
    const [status, progress, stage, currentPage, totalPages, error, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string)!;
    Object.assign(row, {
      status: status ?? row.status,
      progress: progress ?? row.progress,
      stage: stage ?? row.stage,
      current_page: currentPage as number | null,
      total_pages: totalPages as number | null,
      error: error as string | null,
      completed_at: completedAt as string | null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setReady() {
    const [status, progress, stage, currentPage, totalPages, resultR2Key, param6, param7, param8, param9, param10] = this.params;
    const hasOutput = this.params.length === 11;
    const outputR2Key = hasOutput ? param6 : null;
    const outputJson = hasOutput ? param7 : null;
    const completedAt = hasOutput ? param8 : param6;
    const updatedAt = hasOutput ? param9 : param7;
    const jobId = hasOutput ? param10 : param8;
    const row = this.env.rows.get(jobId as string)!;
    Object.assign(row, {
      status,
      progress,
      stage,
      current_page: currentPage as number | null,
      total_pages: totalPages as number | null,
      result_r2_key: resultR2Key,
      ...(hasOutput ? { output_r2_key: outputR2Key as string, output_json: outputJson as string } : {}),
      error: null,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setDeleted() {
    const [status, progress, stage, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      result_r2_key: null,
      output_r2_key: null,
      output_json: null,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private insertPage() {
    const [jobId, clientId, pageIndex, status, createdAt, updatedAt] = this.params;
    const exists = this.env.pages.some((row) => row.job_id === jobId && row.page_index === pageIndex);
    if (exists) return 0;
    this.env.pages.push({
      job_id: jobId as string,
      client_id: clientId as string,
      page_index: pageIndex as number,
      status: status as string,
      attempt_count: 0,
      result_r2_key: null,
      error: null,
      processing_started_at: null,
      processing_lease_until: null,
      created_at: createdAt as string,
      updated_at: updatedAt as string,
    });
    return 1;
  }

  private claimPage() {
    const [status, startedAt, leaseUntil, updatedAt, jobId, pageIndex] = this.params;
    const row = this.env.pages.find((page) => page.job_id === jobId && page.page_index === pageIndex);
    if (!row || !['queued', 'failed'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      attempt_count: row.attempt_count + 1,
      error: null,
      processing_started_at: startedAt,
      processing_lease_until: leaseUntil,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setPageReady() {
    const [status, resultR2Key, updatedAt, jobId, pageIndex] = this.params;
    const row = this.env.pages.find((page) => page.job_id === jobId && page.page_index === pageIndex);
    if (!row) return 0;
    Object.assign(row, {
      status,
      result_r2_key: resultR2Key,
      error: null,
      processing_started_at: null,
      processing_lease_until: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setPageFailed() {
    const [status, error, updatedAt, jobId, pageIndex] = this.params;
    const row = this.env.pages.find((page) => page.job_id === jobId && page.page_index === pageIndex);
    if (!row) return 0;
    Object.assign(row, {
      status,
      error,
      processing_started_at: null,
      processing_lease_until: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private insertEvent() {
    const [eventId, jobId, clientId, sequence, type, payloadJson, createdAt] = this.params;
    this.env.events.push({
      event_id: eventId as string,
      job_id: jobId as string,
      client_id: clientId as string,
      sequence: sequence as number,
      type: type as string,
      payload_json: payloadJson as string,
      created_at: createdAt as string,
    });
    return 1;
  }

  private insertDelivery() {
    const [deliveryId, eventId, jobId, clientId, callbackUrl, payloadJson, status, nextAttemptAt, createdAt, updatedAt] = this.params;
    this.env.deliveries.set(deliveryId as string, {
      delivery_id: deliveryId as string,
      event_id: eventId as string,
      job_id: jobId as string,
      client_id: clientId as string,
      callback_url: callbackUrl as string,
      payload_json: payloadJson as string,
      status: status as string,
      attempt_count: 0,
      next_attempt_at: nextAttemptAt as string,
      last_error: null,
      created_at: createdAt as string,
      updated_at: updatedAt as string,
    });
    return 1;
  }

  private markDelivered() {
    const [status, updatedAt, deliveryId] = this.params;
    const row = this.env.deliveries.get(deliveryId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      attempt_count: row.attempt_count + 1,
      next_attempt_at: null,
      last_error: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private markFailed() {
    const [status, attempts, nextAttemptAt, error, updatedAt, deliveryId] = this.params;
    const row = this.env.deliveries.get(deliveryId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      attempt_count: attempts,
      next_attempt_at: nextAttemptAt,
      last_error: error,
      updated_at: updatedAt,
    });
    return 1;
  }

  private selectRows() {
    const sql = normalizeSql(this.sql);
    if (sql.includes('select coalesce(max(sequence)')) {
      const [jobId] = this.params;
      const max = this.env.events.filter((row) => row.job_id === jobId).reduce((value, row) => Math.max(value, row.sequence), 0);
      return [{ sequence: max + 1 }];
    }
    if (sql.includes('from ocr_job_events')) {
      const [jobId, clientId, afterSequence] = this.params;
      return this.env.events
        .filter((row) => row.job_id === jobId && row.client_id === clientId && row.sequence > (afterSequence as number))
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, 100);
    }
    if (sql.includes("status in ('queued', 'processing', 'cancel_requested')")) {
      const [clientId] = this.params;
      return [...this.env.rows.values()]
        .filter((row) => row.client_id === clientId && ['queued', 'processing', 'cancel_requested'].includes(row.status))
        .map((row) => ({ job_id: row.job_id }));
    }
    if (sql.includes('from ocr_webhook_deliveries')) {
      const [now] = this.params;
      return [...this.env.deliveries.values()].filter(
        (row) => ['pending', 'failed'].includes(row.status) && (!row.next_attempt_at || row.next_attempt_at <= (now as string)),
      );
    }
    if (sql.includes('from ocr_job_pages')) {
      const [jobId, status] = this.params;
      return this.env.pages
        .filter((row) => row.job_id === jobId && (status === undefined || row.status === status))
        .sort((a, b) => a.page_index - b.page_index);
    }
    if (sql.includes('where client_id = ? and idempotency_key = ?')) {
      const [clientId, idempotencyKey] = this.params;
      return [...this.env.rows.values()].filter((row) => row.client_id === clientId && row.idempotency_key === idempotencyKey);
    }
    if (sql.includes('where job_id = ? and client_id = ?')) {
      const [jobId, clientId] = this.params;
      const row = this.env.rows.get(jobId as string);
      return row && row.client_id === clientId ? [row] : [];
    }
    if (sql.includes('where expires_at <= ?')) {
      const [now, deleted] = this.params;
      return [...this.env.rows.values()].filter((row) => row.expires_at <= (now as string) && row.status !== deleted);
    }
    if (sql.includes('where status = ? and processing_lease_until')) {
      const [status, now] = this.params;
      return [...this.env.rows.values()]
        .filter((row) => row.status === status && row.processing_lease_until && row.processing_lease_until <= (now as string))
        .map((row) => ({ job_id: row.job_id }));
    }
    if (sql.includes('where job_id = ?')) {
      const row = this.env.rows.get(this.params[0] as string);
      return row ? [row] : [];
    }
    return [];
  }
}

async function normalizeR2Value(value: string | ReadableStream | ArrayBuffer): Promise<Uint8Array | string> {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ');
}
