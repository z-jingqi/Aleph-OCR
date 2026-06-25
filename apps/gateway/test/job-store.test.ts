import { describe, expect, it } from 'vitest';
import {
  cleanupExpiredJobs,
  claimJobForProcessing,
  createJob,
  deleteJob,
  getJobByIdempotencyKey,
  getJob,
  getResult,
  initializeJobPages,
  listJobEvents,
  requestJobCancel,
  resetExpiredProcessingJobs,
  setJobResult,
  updateJobProgress,
} from '../src/job-store';
import type { OcrDocument, OcrResult } from '@aleph-tools/shared';
import { fakeEnv } from './helpers';

describe('durable job store', () => {
  it('creates client-isolated jobs with progress snapshots and events', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
      callbackMetadata: { documentId: 'doc_123' },
    });

    expect(await getJob(env, 'other-client', job.jobId)).toBeNull();
    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'queued',
      progress: 0,
      stage: 'queued',
      expiresAt: expect.any(String),
      callbackUrl: 'https://app.test/ocr/webhook',
      callbackMetadata: { documentId: 'doc_123' },
    });

    const events = await listJobEvents(env, 'example-client-dev', job.jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 1, type: 'job.created' });
  });

  it('reuses existing jobs by client idempotency key', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const first = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      idempotencyKey: 'idem-1',
    });
    const second = await createJob(env, 'example-client-dev', document, new File(['different'], 'receipt.png', { type: 'image/png' }), {
      idempotencyKey: 'idem-1',
    });

    expect(second.jobId).toBe(first.jobId);
    expect(await getJobByIdempotencyKey(env, 'example-client-dev', 'idem-1')).toMatchObject({ jobId: first.jobId });
    expect(env.rows.size).toBe(1);
  });

  it('cancels queued and processing jobs without changing terminal jobs', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const queued = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    expect(await requestJobCancel(env, 'example-client-dev', queued.jobId)).toMatchObject({ status: 'cancelled', progress: 100 });

    const processing = await createJob(env, 'example-client-dev', document, new File(['def'], 'receipt.png', { type: 'image/png' }));
    await claimJobForProcessing(env, processing.jobId);
    expect(await requestJobCancel(env, 'example-client-dev', processing.jobId)).toMatchObject({ status: 'cancel_requested' });

    const terminal = await requestJobCancel(env, 'example-client-dev', queued.jobId);
    expect(terminal).toMatchObject({ status: 'cancelled' });
  });

  it('initializes durable page rows once for PDF jobs', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'bill.pdf', mimeType: 'application/pdf' };
    const job = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'bill.pdf', { type: 'application/pdf' }));

    await initializeJobPages(env, job, 2);
    await initializeJobPages(env, job, 2);

    expect(env.pages.map((page) => [page.page_index, page.status])).toEqual([
      [0, 'queued'],
      [1, 'queued'],
    ]);
  });

  it('claims jobs once and writes progress events in sequence', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));

    const claimed = await claimJobForProcessing(env, job.jobId);
    expect(claimed).toMatchObject({ status: 'processing', progress: 10, attemptCount: 1 });
    await updateJobProgress(env, claimed!, { progress: 50, stage: 'ocr' });

    expect(await claimJobForProcessing(env, job.jobId)).toBeNull();
    const events = await listJobEvents(env, 'example-client-dev', job.jobId);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'job.created'],
      [2, 'job.status'],
      [3, 'job.progress'],
    ]);
  });

  it('stores result in R2 before marking ready and creating webhook delivery', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    const claimed = await claimJobForProcessing(env, job.jobId);
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

    const ready = await setJobResult(env, claimed!, result);

    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    expect((await getJob(env, 'example-client-dev', job.jobId))?.progress).toBe(100);
    expect((await getResult(env, ready))?.plainText).toBe('total 12');
    expect([...env.deliveries.values()]).toHaveLength(1);
    expect(JSON.parse([...env.deliveries.values()][0].payload_json)).toMatchObject({
      event: 'ocr.job.ready',
      jobId: job.jobId,
      resultUrl: `/v1/jobs/${job.jobId}/result`,
    });
  });

  it('does not mark ready when R2 result write fails', async () => {
    const env = fakeEnv({ failJsonResultPut: true });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    const claimed = await claimJobForProcessing(env, job.jobId);
    const result: OcrResult = {
      engine: 'test',
      engineVersion: '1',
      document,
      pages: [],
      plainText: '',
      markdown: '',
    };

    await expect(setJobResult(env, claimed!, result)).rejects.toThrow('R2 result write failed');
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('processing');
    expect([...env.deliveries.values()]).toHaveLength(0);
  });

  it('requeues expired processing jobs and deletes expired objects during cleanup', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'bill.pdf', mimeType: 'application/pdf' };
    const job = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'bill.pdf', { type: 'application/pdf' }));
    const claimed = await claimJobForProcessing(env, job.jobId);
    env.rows.get(claimed!.jobId)!.processing_lease_until = '2000-01-01T00:00:00.000Z';

    await expect(resetExpiredProcessingJobs(env, '2026-01-01T00:00:00.000Z')).resolves.toEqual([job.jobId]);
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('queued');

    expect(await deleteJob(env, 'other-client', job.jobId)).toBeNull();
    const deleted = await deleteJob(env, 'example-client-dev', job.jobId);
    expect(deleted?.status).toBe('deleted');

    const expired = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'bill.pdf', { type: 'application/pdf' }));
    env.rows.get(expired.jobId)!.expires_at = '2000-01-01T00:00:00.000Z';
    expect(await cleanupExpiredJobs(env)).toBe(1);
    expect((await getJob(env, 'example-client-dev', expired.jobId))?.status).toBe('deleted');
  });
});
