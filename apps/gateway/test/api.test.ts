import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { processJob } from '../src/index';
import { fakeEnv, fixtureFile } from './helpers';

describe('gateway API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns structured unauthorized errors with request IDs', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(new Request('https://tools.test/v1/jobs/job_missing'), env, {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED', httpStatus: 401, retryable: false },
    });
  });

  it('maps engine failures to stable error codes', async () => {
    const env = fakeEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('engine down', { status: 503 })));
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/ocr/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'ENGINE_UNAVAILABLE', message: 'engine down', retryable: true },
    });
  });

  it('maps unsupported conversion capabilities to UNSUPPORTED_FORMAT', async () => {
    const env = fakeEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AVIF output is not supported by this container image', { status: 501 })));
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('targetFormat', 'avif');

    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_FORMAT', retryable: false },
    });
  });

  it('converts images synchronously and returns binary output', async () => {
    const env = fakeEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'X-Aleph-Tools-Filename': 'receipt.webp',
          'X-Aleph-Tools-Width': '320',
          'X-Aleph-Tools-Height': '240',
          'X-Aleph-Tools-Format': 'webp',
        },
      })),
    );
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('targetFormat', 'webp');
    form.append('width', '320');

    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-disposition')).toContain('receipt.webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('creates async image conversion jobs with idempotency and tool metadata', async () => {
    const env = fakeEnv();
    const makeRequest = async () => {
      const form = new FormData();
      form.append('file', await fixtureFile('images/invoice-table.png', 'image/png'));
      form.append('targetFormat', 'jpeg');
      form.append('quality', '82');
      form.append('metadata', JSON.stringify({ assetId: 'asset_123' }));
      return handler.fetch(
        new Request('https://tools.test/v1/tools/image/convert', {
          method: 'POST',
          headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'convert-asset-123' },
          body: form,
        }),
        env,
        {} as ExecutionContext,
      );
    };

    const first = (await (await makeRequest()).json()) as { data: { jobId: string; tool: string; operation: string } };
    const second = (await (await makeRequest()).json()) as { data: { jobId: string } };

    expect(first.data).toMatchObject({ tool: 'image.convert', operation: 'image.convert' });
    expect(second.data.jobId).toBe(first.data.jobId);
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"targetFormat":"jpeg"');
    expect(env.workflowCreates).toHaveLength(1);
  });

  it('returns idempotency conflict when the same key is reused with different input', async () => {
    const env = fakeEnv();
    const firstForm = new FormData();
    firstForm.append('file', await fixtureFile('images/invoice-table.png', 'image/png'));
    firstForm.append('targetFormat', 'jpeg');
    const firstResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'convert-conflict' },
        body: firstForm,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);

    const secondForm = new FormData();
    secondForm.append('file', await fixtureFile('images/invoice-table.png', 'image/png'));
    secondForm.append('targetFormat', 'webp');
    const conflictResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'convert-conflict' },
        body: secondForm,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
    });
  });

  it('rate-limits active jobs per client when configured', async () => {
    const env = fakeEnv({ MAX_ACTIVE_JOBS_PER_CLIENT: '1' });
    const firstForm = new FormData();
    firstForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const firstResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: firstForm,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);

    const secondForm = new FormData();
    secondForm.append('file', await fixtureFile('images/checklist-photo.png', 'image/png'));
    const limitedResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: secondForm,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(limitedResponse.status).toBe(429);
    await expect(limitedResponse.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('rejects output downloads before a conversion job is ready', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/checklist-photo.png', 'image/png'));
    form.append('targetFormat', 'png');
    const createResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const outputResponse = await handler.fetch(
      new Request(`https://tools.test/v1/jobs/${createBody.data.jobId}/output`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(outputResponse.status).toBe(409);
    expect(outputResponse.headers.get('X-Request-Id')).toBeTruthy();
    await expect(outputResponse.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'JOB_NOT_READY', jobStatus: 'queued', retryable: true, terminal: false },
    });
  });

  it('downloads ready image conversion outputs as binary files', async () => {
    const env = fakeEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'X-Aleph-Tools-Filename': 'checklist-photo.png',
          'X-Aleph-Tools-Width': '640',
          'X-Aleph-Tools-Height': '480',
          'X-Aleph-Tools-Format': 'png',
        },
      })),
    );
    const form = new FormData();
    form.append('file', await fixtureFile('images/checklist-photo.png', 'image/png'));
    form.append('targetFormat', 'png');
    const createResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    await processJob(env, createBody.data.jobId);

    const outputResponse = await handler.fetch(
      new Request(`https://tools.test/v1/jobs/${createBody.data.jobId}/output`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(outputResponse.status).toBe(200);
    expect(outputResponse.headers.get('content-type')).toBe('image/png');
    expect(outputResponse.headers.get('content-disposition')).toContain('checklist-photo.png');
    expect(new Uint8Array(await outputResponse.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('creates image jobs with callback metadata and returns progress snapshot', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('callbackUrl', 'https://app.test/ocr/webhook');
    form.append('metadata', JSON.stringify({ documentId: 'doc_123' }));

    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(createResponse.status).toBe(202);
    expect(createResponse.headers.get('X-Request-Id')).toBeTruthy();
    const createBody = (await createResponse.json()) as { requestId: string; data: { jobId: string; status: string; progress: number } };
    expect(createBody.requestId).toBeTruthy();
    expect(createBody.data).toMatchObject({
      status: 'queued',
      progress: 0,
      terminal: false,
      cancelable: true,
      retryable: true,
      resultAvailable: false,
      outputAvailable: false,
    });
    expect(env.workflowCreates).toHaveLength(1);
    expect(env.workflowCreates[0].params).toEqual({ jobId: createBody.data.jobId });

    const getResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      data: { jobId: createBody.data.jobId, progress: 0, stage: 'queued', terminal: false, cancelable: true },
    });
  });

  it('reuses jobs for repeated Idempotency-Key requests', async () => {
    const env = fakeEnv();
    const makeRequest = async () => {
      const form = new FormData();
      form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
      return handler.fetch(
        new Request('https://ocr.test/v1/jobs', {
          method: 'POST',
          headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'upload-123' },
          body: form,
        }),
        env,
        {} as ExecutionContext,
      );
    };

    const first = (await (await makeRequest()).json()) as { data: { jobId: string } };
    const second = (await (await makeRequest()).json()) as { data: { jobId: string } };

    expect(second.data.jobId).toBe(first.data.jobId);
    expect(env.rows.size).toBe(1);
    expect(env.workflowCreates).toHaveLength(1);
  });

  it('rejects oversized Idempotency-Key values', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'x'.repeat(257), 'Content-Type': 'multipart/form-data' },
        body: new FormData(),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Idempotency-Key must be 256 characters or fewer', retryable: false },
    });
  });

  it('cancels queued jobs through the API and emits cancellable snapshots', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/checklist-photo.png', 'image/png'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const cancelResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      success: true,
      data: { status: 'cancelled', stage: 'cancelled', progress: 100 },
    });
    expect(env.events.at(-1)?.type).toBe('job.cancelled');
  });

  it('accepts PDF fixtures and rejects result reads before ready', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));

    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const resultResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(resultResponse.status).toBe(409);
    await expect(resultResponse.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'JOB_NOT_READY', jobStatus: 'queued', retryable: true, terminal: false },
    });
  });

  it('returns stable result errors for terminal and missing-result states', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    const row = env.rows.get(createBody.data.jobId)!;

    row.status = 'failed';
    row.stage = 'failed';
    row.error = 'engine unavailable';
    const failed = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, { headers: { Authorization: 'Bearer dev-key' } }),
      env,
      {} as ExecutionContext,
    );
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: 'JOB_FAILED', jobStatus: 'failed', terminal: true, retryable: false },
    });

    row.status = 'cancelled';
    row.stage = 'cancelled';
    row.error = null;
    const cancelled = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, { headers: { Authorization: 'Bearer dev-key' } }),
      env,
      {} as ExecutionContext,
    );
    expect(cancelled.status).toBe(409);
    await expect(cancelled.json()).resolves.toMatchObject({ error: { code: 'JOB_CANCELLED', jobStatus: 'cancelled' } });

    row.status = 'deleted';
    row.stage = 'deleted';
    const deleted = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, { headers: { Authorization: 'Bearer dev-key' } }),
      env,
      {} as ExecutionContext,
    );
    expect(deleted.status).toBe(410);
    await expect(deleted.json()).resolves.toMatchObject({ error: { code: 'JOB_DELETED', jobStatus: 'deleted' } });

    row.status = 'ready';
    row.stage = 'ready';
    row.result_r2_key = 'results/missing.json';
    const missing = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, { headers: { Authorization: 'Bearer dev-key' } }),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(500);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'RESULT_NOT_FOUND', jobStatus: 'ready', terminal: true } });
  });

  it('streams an SSE snapshot and stored events for authorized clients', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/invoice-table.png', 'image/png'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const sseResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/events?once=1`, {
        headers: { Authorization: 'Bearer dev-key', 'Last-Event-ID': '0' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toContain('text/event-stream');
    const text = await sseResponse.text();
    expect(text).toContain('event: job.snapshot');
    expect(text).toContain('event: job.created');
    expect(text).toContain(createBody.data.jobId);
  });

  it('protects SSE with the same client ownership rules', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/checklist-photo.png', 'image/png'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const sseResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/events?once=1`, {
        headers: { Authorization: 'Bearer other-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(sseResponse.status).toBe(404);
  });
});
