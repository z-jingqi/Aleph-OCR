import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, requestJobCancel } from '../src/job-store';
import { processJob } from '../src/index';
import { fakeEnv, sampleOcrResult } from './helpers';
import type { OcrDocument } from '@aleph-ocr/shared';

describe('job lifecycle processing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('processes a queued job to ready and ignores duplicate queue messages', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    const fetchMock = vi.fn(async () => Response.json(sampleOcrResult(document)));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);
    await processJob(env, job.jobId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'ready',
      progress: 100,
      stage: 'ready',
      totalPages: 1,
    });
  });

  it('records failed jobs and emits failure events when OCR throws', async () => {
    const env = fakeEnv({ MAX_JOB_ATTEMPTS: '1' });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('engine unavailable', { status: 503 })));

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'failed',
      stage: 'failed',
      error: 'engine unavailable',
    });
    expect(env.events.at(-1)?.type).toBe('job.failed');
  });

  it('keeps ready result when webhook delivery fails', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(sampleOcrResult(document)))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('failed');
    expect(delivery.last_error).toBe('Webhook returned 500');
  });

  it('processes PDF jobs page by page and merges final result', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'mixed.pdf', mimeType: 'application/pdf', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'mixed.pdf', { type: 'application/pdf' }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ pageCount: 2 }))
      .mockResolvedValueOnce(Response.json(sampleOcrResult({ ...document, filename: 'mixed.pdf#page=1' })))
      .mockResolvedValueOnce(Response.json({
        ...sampleOcrResult({ ...document, filename: 'mixed.pdf#page=2' }),
        pages: [{ pageIndex: 1, width: 100, height: 100, text: 'Second page', blocks: [], tables: [], confidence: 0.9 }],
        plainText: 'Second page',
        markdown: 'Second page',
      }));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    const ready = await getJob(env, 'example-client-dev', job.jobId);
    expect(ready).toMatchObject({ status: 'ready', progress: 100, currentPage: 2, totalPages: 2 });
    expect(env.pages.map((page) => page.status)).toEqual(['ready', 'ready']);
    expect([...env.objects.keys()].filter((key) => key.includes('page-results'))).toHaveLength(2);
  });

  it('honors cancel requests between PDF pages and does not write ready result', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'mixed.pdf', mimeType: 'application/pdf', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'mixed.pdf', { type: 'application/pdf' }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ pageCount: 2 }))
      .mockImplementationOnce(async () => {
        await requestJobCancel(env, 'example-client-dev', job.jobId);
        return Response.json(sampleOcrResult({ ...document, filename: 'mixed.pdf#page=1' }));
      });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({ status: 'cancelled', stage: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...env.objects.keys()].some((key) => key.includes('/results/'))).toBe(false);
  });
});
