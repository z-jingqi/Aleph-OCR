import { describe, expect, it } from 'vitest';
import {
  cleanupExpiredJobs,
  createJob,
  deleteJob,
  getJob,
  getResult,
  setJobResult,
  setJobStatus,
} from '../src/job-store';
import type { OcrDocument, OcrResult } from '@aleph-ocr/shared';

describe('durable job store', () => {
  it('creates client-isolated jobs and stores results in R2', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));

    expect(await getJob(env, 'other-client', job.jobId)).toBeNull();
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('queued');

    await setJobStatus(env, job.jobId, 'processing');
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('processing');

    const result: OcrResult = {
      jobId: job.jobId,
      status: 'ready',
      engine: 'test',
      engineVersion: '1',
      document,
      pages: [{ pageIndex: 0, width: 10, height: 10, text: 'total 12', blocks: [], tables: [], confidence: 0.9 }],
      plainText: 'total 12',
      markdown: 'total 12',
    };
    await setJobResult(env, job, result);
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    expect((await getResult(env, { ...job, resultR2Key: `results/example-client-dev/${job.jobId}.json` }))?.plainText).toBe(
      'total 12',
    );
  });

  it('deletes only the owning client job and cleanup removes expired objects', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'bill.pdf', mimeType: 'application/pdf' };
    const job = await createJob(env, 'client-a', document, new File(['pdf'], 'bill.pdf', { type: 'application/pdf' }));

    expect(await deleteJob(env, 'client-b', job.jobId)).toBeNull();
    expect((await deleteJob(env, 'client-a', job.jobId))?.status).toBe('deleted');

    const expired = await createJob(env, 'client-a', document, new File(['pdf'], 'bill.pdf', { type: 'application/pdf' }));
    env.rows.get(expired.jobId)!.expires_at = '2000-01-01T00:00:00.000Z';
    expect(await cleanupExpiredJobs(env)).toBe(1);
    expect((await getJob(env, 'client-a', expired.jobId))?.status).toBe('deleted');
  });
});

type Row = {
  job_id: string;
  client_id: string;
  status: string;
  document_json: string;
  source_r2_key: string;
  result_r2_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

function fakeEnv() {
  const rows = new Map<string, Row>();
  const objects = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return new FakeStatement(rows, sql);
    },
  } as unknown as D1Database;
  const assets = {
    async put(key: string, value: string | ReadableStream | ArrayBuffer) {
      objects.set(key, typeof value === 'string' ? value : '');
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return value;
        },
        async arrayBuffer() {
          return new TextEncoder().encode(value).buffer;
        },
      } as R2ObjectBody;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { DB: db, ASSETS: assets, rows };
}

class FakeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly rows: Map<string, Row>,
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
    const sql = this.sql;
    if (sql.includes('INSERT INTO ocr_jobs')) {
      const [jobId, clientId, status, documentJson, sourceR2Key, createdAt, updatedAt, expiresAt] = this.params;
      this.rows.set(jobId as string, {
        job_id: jobId as string,
        client_id: clientId as string,
        status: status as string,
        document_json: documentJson as string,
        source_r2_key: sourceR2Key as string,
        result_r2_key: null,
        error: null,
        created_at: createdAt as string,
        updated_at: updatedAt as string,
        expires_at: expiresAt as string,
      });
    } else if (sql.includes('SET status = ?, error = ?')) {
      const [status, error, updatedAt, jobId] = this.params;
      Object.assign(this.rows.get(jobId as string)!, { status, error, updated_at: updatedAt });
    } else if (sql.includes('SET status = ?, result_r2_key = ?')) {
      const [status, resultR2Key, updatedAt, jobId] = this.params;
      Object.assign(this.rows.get(jobId as string)!, { status, result_r2_key: resultR2Key, error: null, updated_at: updatedAt });
    } else if (sql.includes('SET status = ?, result_r2_key = NULL')) {
      const [status, updatedAt, jobId] = this.params;
      Object.assign(this.rows.get(jobId as string)!, { status, result_r2_key: null, updated_at: updatedAt });
    }
    return { success: true };
  }

  private selectRows() {
    if (this.sql.includes('WHERE job_id = ? AND client_id = ?')) {
      const [jobId, clientId] = this.params;
      const row = this.rows.get(jobId as string);
      return row && row.client_id === clientId ? [row] : [];
    }
    if (this.sql.includes('WHERE expires_at <= ?')) {
      const [now, deleted] = this.params;
      return [...this.rows.values()].filter((row) => row.expires_at <= (now as string) && row.status !== deleted);
    }
    if (this.sql.includes('WHERE job_id = ?')) {
      const row = this.rows.get(this.params[0] as string);
      return row ? [row] : [];
    }
    return [];
  }
}
