import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, getResult, requestJobCancel } from '../src/job-store';
import { processJob } from '../src/index';
import { fakeEnv, sampleOcrResult } from './helpers';
import type { OcrDocument } from '@aleph-tools/shared';

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

  it('does not emit terminal failed state before retry attempts are exhausted', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('engine unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json(sampleOcrResult(document)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(processJob(env, job.jobId)).rejects.toThrow('engine unavailable');

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'queued',
      stage: 'queued',
      error: 'engine unavailable',
      attemptCount: 1,
    });
    expect(env.events.map((event) => event.type)).not.toContain('job.failed');
    expect(env.deliveries.size).toBe(0);

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'ready',
      progress: 100,
      attemptCount: 2,
    });
    expect(env.events.map((event) => event.type)).not.toContain('job.failed');
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

  it('processes PDF jobs by batch and merges final result', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'pdf', filename: 'mixed.pdf', mimeType: 'application/pdf', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['pdf'], 'mixed.pdf', { type: 'application/pdf' }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ pageCount: 2 }))
      .mockResolvedValueOnce(Response.json(samplePdfBatchResult(document, 0, 2)));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-batch']);
    const ready = await getJob(env, 'example-client-dev', job.jobId);
    expect(ready).toMatchObject({ status: 'ready', progress: 100, currentPage: 2, totalPages: 2 });
    expect(env.pages.map((page) => page.status)).toEqual(['ready', 'ready']);
    expect([...env.objects.keys()].filter((key) => key.includes('page-results'))).toHaveLength(2);
  });

  it('processes image conversion jobs to ready output metadata and R2 output', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      tool: 'image.convert',
      operation: 'image.convert',
      toolOptions: { targetFormat: 'webp', width: 320, fit: 'inside' },
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([4, 5, 6]), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'X-Aleph-Tools-Filename': 'receipt.webp',
        'X-Aleph-Tools-Width': '320',
        'X-Aleph-Tools-Height': '240',
        'X-Aleph-Tools-Format': 'webp',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    const ready = await getJob(env, 'example-client-dev', job.jobId);
    expect(ready).toMatchObject({
      status: 'ready',
      tool: 'image.convert',
      output: { filename: 'receipt.webp', mimeType: 'image/webp', width: 320, height: 240, format: 'webp' },
    });
    await expect(getResult(env, ready!)).resolves.toMatchObject({
      tool: 'image.convert',
      output: { resultUrl: `/v1/jobs/${job.jobId}/output` },
    });
    expect([...env.objects.keys()].some((key) => key.includes('outputs/') && key.endsWith('/receipt.webp'))).toBe(true);
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
        return Response.json(samplePdfBatchResult(document, 0, 2));
      });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({ status: 'cancelled', stage: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...env.objects.keys()].some((key) => key.includes('/results/'))).toBe(false);
  });
});

function requestUrl(input: unknown): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function samplePdfBatchResult(document: OcrDocument, startPage: number, pageCount: number) {
  const pages = Array.from({ length: pageCount }, (_, offset) => {
    const pageIndex = startPage + offset;
    return {
      pageIndex,
      width: 100,
      height: 100,
      text: `Page ${pageIndex + 1}`,
      blocks: [{ text: `Page ${pageIndex + 1}`, confidence: 0.9 }],
      tables: [],
      confidence: 0.9,
      ocrMode: 'balanced',
      requestedOcrMode: 'balanced',
      fallbackUsed: false,
      quality: { lowQuality: false, reasons: [], fallbackReasons: [] },
      timingsMs: { total: 10, requestedTotal: 10, fallbackTotal: 0 },
    };
  });
  return {
    engine: 'mock',
    engineVersion: '1',
    document,
    pages,
    plainText: pages.map((page) => page.text).join('\n\n'),
    markdown: pages.map((page) => `## Page ${page.pageIndex + 1}\n\n${page.text}`).join('\n\n'),
    ocrMode: 'balanced',
    requestedOcrMode: 'balanced',
    fallbackUsed: false,
    quality: { lowQuality: false, reasons: [], fallbackReasons: [] },
    timingsMs: { total: 10 * pageCount, requestedTotal: 10 * pageCount, fallbackTotal: 0 },
  };
}
