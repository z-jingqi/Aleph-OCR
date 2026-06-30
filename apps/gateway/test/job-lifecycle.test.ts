import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, getResult, requestJobCancel } from '../src/job-store';
import { processJob } from '../src/index';
import { fakeEnv, sampleGoogleVisionResponse } from './helpers';
import type { OcrDocument } from '@aleph-tools/shared';

describe('OCR job lifecycle processing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('processes a queued image job to ready and ignores duplicate queue messages', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    const fetchMock = vi.fn(async () => Response.json(sampleGoogleVisionResponse('total 12')));
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
    await expect(getResult(env, (await getJob(env, 'example-client-dev', job.jobId))!)).resolves.toMatchObject({
      engine: 'google-vision',
      plainText: 'total 12',
    });
  });

  it('converts HEIC before OCR inside the workflow', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.heic', mimeType: 'image/heic', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['heic'], 'receipt.heic', { type: 'image/heic' }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(sampleGoogleVisionResponse('converted total'))));

    await processJob(env, job.jobId);

    const ready = await getJob(env, 'example-client-dev', job.jobId);
    await expect(getResult(env, ready!)).resolves.toMatchObject({
      document: { filename: 'receipt.from-heic.jpg', mimeType: 'image/jpeg' },
      metadata: { input: { converted: true, originalMimeType: 'image/heic' } },
    });
  });

  it('records failed jobs and emits failure events when Google Vision rejects the request', async () => {
    const env = fakeEnv({ MAX_JOB_ATTEMPTS: '1' });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { status: 'PERMISSION_DENIED', message: 'permission denied' } },
      { status: 403 },
    )));

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'failed',
      stage: 'failed',
      error: 'permission denied',
    });
    expect(env.events.at(-1)?.type).toBe('job.failed');
  });

  it('requeues retryable Google Vision failures before terminal failure', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { status: 'UNAVAILABLE', message: 'temporary unavailable' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(sampleGoogleVisionResponse('ready after retry')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(processJob(env, job.jobId)).rejects.toThrow('temporary unavailable');
    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({
      status: 'queued',
      stage: 'queued',
      error: 'temporary unavailable',
      attemptCount: 1,
    });

    await processJob(env, job.jobId);
    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({ status: 'ready', attemptCount: 2 });
  });

  it('keeps ready result when webhook delivery fails', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(sampleGoogleVisionResponse('webhook test')))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('failed');
    expect(delivery.last_error).toBe('Webhook returned 500');
  });

  it('honors cancellation before writing ready result', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }));
    await requestJobCancel(env, 'example-client-dev', job.jobId);

    await processJob(env, job.jobId);

    expect(await getJob(env, 'example-client-dev', job.jobId)).toMatchObject({ status: 'cancelled' });
    expect([...env.objects.keys()].some((key) => key.includes('/results/'))).toBe(false);
  });
});
