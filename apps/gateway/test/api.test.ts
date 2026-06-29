import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { processJob } from '../src/index';
import { fakeEnv, fixtureFile, sampleOcrResult } from './helpers';

const engineInfo = {
  engine: 'paddleocr',
  engineVersion: '3.x',
  modes: ['tiny', 'small', 'medium'],
  defaultMode: 'small',
  modeConfig: {
    tiny: { detector: 'mobile', pdfRenderDpi: 160 },
    small: { detector: 'standard', pdfRenderDpi: 200 },
    medium: { detector: 'server', pdfRenderDpi: 240 },
  },
  capabilities: {
    image: true,
    pdf: true,
    syncImage: true,
    imageConvert: true,
    imageConvertFormats: ['png', 'jpeg', 'webp', 'avif'],
    imageCompress: true,
    imageCompressFormats: ['jpeg', 'webp'],
    asyncJobs: true,
    layout: true,
    tables: false,
  },
  limits: {
    maxSyncImageSizeBytes: 10 * 1024 * 1024,
    maxPdfPages: 100,
    pdfBatchSize: 1,
    pdfRenderDpi: 200,
  },
};

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

  it('disables sync endpoints but keeps async image tools enabled', async () => {
    const env = fakeEnv();
    delete env.ENABLE_SYNC_ENDPOINTS;

    const syncForm = new FormData();
    syncForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const syncResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: syncForm,
      }),
      env,
      {} as ExecutionContext,
    );

    const convertForm = new FormData();
    convertForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    convertForm.append('targetFormat', 'webp');
    const convertResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/convert', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'convert-enabled' },
        body: convertForm,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(syncResponse.status).toBe(400);
    expect(convertResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    await expect(convertResponse.json()).resolves.toMatchObject({ success: true, data: { tool: 'image.convert' } });
  });

  it('returns engine OCR modes and mode config', async () => {
    const env = fakeEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(engineInfo)));

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/engines', {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        modes: ['tiny', 'small', 'medium'],
        defaultMode: 'small',
        modeConfig: { medium: { pdfRenderDpi: 240 } },
      },
    });
  });

  it('maps engine failures to stable error codes', async () => {
    const env = fakeEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('engine down', { status: 503 })));
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr/sync', {
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

  it('passes OCR mode to sync OCR requests', async () => {
    const env = fakeEnv();
    const fetchMock = vi.fn(async (_input: unknown) => Response.json(sampleOcrResult()));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('ocrMode', 'medium');

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(requestUrl(fetchMock.mock.calls[0]![0]).pathname).toBe('/internal/ocr/image');
    expect(requestUrl(fetchMock.mock.calls[0]![0]).searchParams.get('mode')).toBe('medium');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { metadata: { ocrMode: 'medium', requestedOcrMode: 'medium', fallbackUsed: false } },
    });
  });

  it('rejects invalid sync OCR modes with a structured validation error', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('ocrMode', 'precise');

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'ocrMode must be one of tiny, small, medium', retryable: false },
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

  it('compresses images synchronously and returns binary output', async () => {
    const env = fakeEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Aleph-Tools-Filename': 'receipt.compressed.jpg',
          'X-Aleph-Tools-Width': '300',
          'X-Aleph-Tools-Height': '200',
          'X-Aleph-Tools-Format': 'jpeg',
          'X-Aleph-Tools-Original-Size-Bytes': '1500',
          'X-Aleph-Tools-Quality': '75',
          'X-Aleph-Tools-Target-Met': 'true',
        },
      })),
    );
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('targetSizeBytes', '900');
    form.append('maxWidth', '300');

    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/compress/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toContain('receipt.compressed.jpg');
    expect(response.headers.get('X-Aleph-Tools-Target-Met')).toBe('true');
  });

  it('creates async image compression jobs with idempotency and tool metadata', async () => {
    const env = fakeEnv();
    const makeRequest = async () => {
      const form = new FormData();
      form.append('file', await fixtureFile('images/invoice-table.png', 'image/png'));
      form.append('targetSizeBytes', '1200');
      form.append('maxWidth', '800');
      form.append('outputFormat', 'webp');
      return handler.fetch(
        new Request('https://tools.test/v1/tools/image/compress', {
          method: 'POST',
          headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'compress-asset-123' },
          body: form,
        }),
        env,
        {} as ExecutionContext,
      );
    };

    const first = (await (await makeRequest()).json()) as { data: { jobId: string; tool: string; operation: string } };
    const second = (await (await makeRequest()).json()) as { data: { jobId: string } };

    expect(first.data).toMatchObject({ tool: 'image.compress', operation: 'image.compress' });
    expect(second.data.jobId).toBe(first.data.jobId);
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"targetSizeBytes":1200');
    expect(env.workflowCreates).toHaveLength(1);
  });

  it('requires idempotency keys for image pipeline jobs', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: await pipelineForm(),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Idempotency-Key is required for image pipeline jobs' },
    });
  });

  it('creates image pipeline jobs through the queue with idempotency', async () => {
    const env = fakeEnv();
    const makeRequest = async () =>
      handler.fetch(
        new Request('https://tools.test/v1/tools/image/pipeline', {
          method: 'POST',
          headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-asset-123' },
          body: await pipelineForm({ metadata: { assetId: 'asset_123' } }),
        }),
        env,
        {} as ExecutionContext,
      );

    const first = (await (await makeRequest()).json()) as { data: { jobId: string; tool: string; operation: string } };
    const second = (await (await makeRequest()).json()) as { data: { jobId: string } };

    expect(first.data).toMatchObject({ tool: 'image.pipeline', operation: 'image.pipeline' });
    expect(second.data.jobId).toBe(first.data.jobId);
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"targetFormat":"jpeg"');
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"enabled":true');
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"targetSizeBytes":350000');
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"maxWidth":1000');
    expect(env.rows.get(first.data.jobId)?.tool_options_json).toContain('"maxQuality":75');
    expect(env.workflowCreates).toHaveLength(0);
    expect(env.queueMessages).toEqual([{ jobId: first.data.jobId }]);
  });

  it('uses aggressive default compression for HEIC image pipeline uploads without overriding explicit fields', async () => {
    const env = fakeEnv();
    const heicFile = new File([new Uint8Array(128)], 'receipt.heic', { type: 'image/heic' });
    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-heic-defaults' },
        body: await pipelineForm({
          file: heicFile,
          pipeline: { compress: { maxWidth: 1800 }, ocr: { ocrMode: 'small' } },
        }),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { data: { jobId: string } };
    const options = JSON.parse(env.rows.get(body.data.jobId)?.tool_options_json ?? '{}') as { compress: Record<string, unknown> };

    expect(options.compress).toMatchObject({
      enabled: true,
      targetSizeBytes: 350000,
      maxWidth: 1800,
      maxHeight: 1200,
      maxQuality: 72,
    });
  });

  it('returns image pipeline idempotency conflicts for changed options', async () => {
    const env = fakeEnv();
    const firstResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-conflict' },
        body: await pipelineForm(),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);

    const conflictResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-conflict' },
        body: await pipelineForm({ pipeline: { compress: { enabled: false }, ocr: { ocrMode: 'small' } } }),
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

  it('validates image pipeline options', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-invalid' },
        body: await pipelineForm({ pipeline: { convert: { targetFormat: 'gif' }, compress: { outputFormat: 'jpeg' }, ocr: { ocrMode: 'small' } } }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', retryable: false },
    });
  });

  it('rejects non-OCR-native pipeline images when conversion is disabled', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-heic-no-convert' },
        body: await pipelineForm({
          file: new File([new Uint8Array([1, 2, 3])], 'receipt.heic', { type: 'image/heic' }),
          pipeline: { convert: { enabled: false }, compress: { enabled: false }, ocr: { ocrMode: 'small' } },
        }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(env.rows.size).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_FORMAT', retryable: false },
    });
  });

  it('rate-limits image pipeline jobs before storing uploads', async () => {
    const env = fakeEnv({ MAX_ACTIVE_JOBS_PER_CLIENT: '1' });
    const firstResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-limit-1' },
        body: await pipelineForm(),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);
    const objectCount = env.objects.size;

    const limitedResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-limit-2' },
        body: await pipelineForm(),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('Retry-After')).toBe('30');
    expect(env.objects.size).toBe(objectCount);
    await expect(limitedResponse.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('processes non-native image pipeline jobs in convert, compress, OCR order', async () => {
    const env = fakeEnv();
    const webpFile = new File([await fixtureFile('images/receipt.png', 'image/png')], 'receipt.webp', { type: 'image/webp' });
    const createResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-process' },
        body: await pipelineForm({ file: webpFile, metadata: { assetId: 'asset_456' } }),
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    const seenPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = requestUrl(input);
        seenPaths.push(url.pathname);
        if (url.pathname === '/internal/image/convert') {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              'Content-Type': 'image/webp',
              'X-Aleph-Tools-Filename': 'receipt.webp',
              'X-Aleph-Tools-Width': '320',
              'X-Aleph-Tools-Height': '240',
              'X-Aleph-Tools-Format': 'webp',
            },
          });
        }
        if (url.pathname === '/internal/image/compress') {
          return new Response(new Uint8Array([4, 5]), {
            headers: {
              'Content-Type': 'image/jpeg',
              'X-Aleph-Tools-Filename': 'receipt.compressed.jpg',
              'X-Aleph-Tools-Width': '300',
              'X-Aleph-Tools-Height': '200',
              'X-Aleph-Tools-Format': 'jpeg',
              'X-Aleph-Tools-Original-Size-Bytes': '3',
              'X-Aleph-Tools-Quality': '72',
              'X-Aleph-Tools-Target-Met': 'true',
            },
          });
        }
        return Response.json(sampleOcrResult({ type: 'image', filename: 'receipt.compressed.jpg', mimeType: 'image/jpeg', sizeBytes: 2 }));
      }),
    );

    await processJob(env, createBody.data.jobId);

    expect(seenPaths).toEqual(['/internal/image/convert', '/internal/image/compress', '/internal/ocr/image']);
    const ocrUrl = requestUrl((globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls[2]![0]);
    expect(ocrUrl.searchParams.get('max_side')).toBe('1400');
    expect(ocrUrl.searchParams.get('document_crop')).toBe('true');
    const resultResponse = await handler.fetch(
      new Request(`https://tools.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const result = (await resultResponse.json()) as { data: { tool: string; converted: { status: string; output: unknown }; compressed: { status: string; output: { filename: string } }; output: { filename: string }; ocr: unknown; timingsMs: Record<string, number> } };
    expect(result.data.tool).toBe('image.pipeline');
    expect(result.data.converted).toMatchObject({ status: 'ran', output: { filename: 'receipt.webp', sizeBytes: 3 } });
    expect(result.data.compressed).toMatchObject({ status: 'ran', output: { filename: 'receipt.compressed.jpg', sizeBytes: 2 } });
    expect(result.data.output).toMatchObject({ filename: 'receipt.compressed.jpg', sizeBytes: 2 });
    expect(result.data.timingsMs).toMatchObject({ convertMs: expect.any(Number), compressMs: expect.any(Number), ocrMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(env.rows.get(createBody.data.jobId)?.output_r2_key).toContain('receipt.compressed.jpg');
  });

  it('skips default pipeline conversion for OCR-native images but still compresses before OCR', async () => {
    const env = fakeEnv();
    const createResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-native-default' },
        body: await pipelineForm(),
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    const seenPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = requestUrl(input);
        seenPaths.push(url.pathname);
        if (url.pathname === '/internal/image/compress') {
          return new Response(new Uint8Array([4, 5]), {
            headers: {
              'Content-Type': 'image/jpeg',
              'X-Aleph-Tools-Filename': 'receipt.compressed.jpg',
              'X-Aleph-Tools-Width': '300',
              'X-Aleph-Tools-Height': '200',
              'X-Aleph-Tools-Format': 'jpeg',
              'X-Aleph-Tools-Original-Size-Bytes': '10',
              'X-Aleph-Tools-Quality': '72',
              'X-Aleph-Tools-Target-Met': 'true',
            },
          });
        }
        return Response.json(sampleOcrResult({ type: 'image', filename: 'receipt.compressed.jpg', mimeType: 'image/jpeg', sizeBytes: 2 }));
      }),
    );

    await processJob(env, createBody.data.jobId);

    expect(seenPaths).toEqual(['/internal/image/compress', '/internal/ocr/image']);
    const ocrUrl = requestUrl((globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls[1]![0]);
    expect(ocrUrl.searchParams.get('max_side')).toBe('1400');
    expect(ocrUrl.searchParams.get('document_crop')).toBe('true');
    const resultResponse = await handler.fetch(
      new Request(`https://tools.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const result = (await resultResponse.json()) as { data: { converted: { status: string }; compressed: { status: string }; output: { filename: string } } };
    expect(result.data.converted).toMatchObject({ status: 'skipped' });
    expect(result.data.compressed).toMatchObject({ status: 'ran' });
    expect(result.data.output).toMatchObject({ filename: 'receipt.compressed.jpg' });
  });

  it('skips pipeline conversion for OCR-native images and can skip compression', async () => {
    const env = fakeEnv();
    const createResponse = await handler.fetch(
      new Request('https://tools.test/v1/tools/image/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pipeline-skip-steps' },
        body: await pipelineForm({ pipeline: { compress: { enabled: false }, ocr: { ocrMode: 'small' } } }),
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    const seenPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = requestUrl(input);
        seenPaths.push(url.pathname);
        return Response.json(sampleOcrResult({ type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 1 }));
      }),
    );

    await processJob(env, createBody.data.jobId);

    expect(seenPaths).toEqual(['/internal/ocr/image']);
    const ocrUrl = requestUrl((globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls[0]![0]);
    expect(ocrUrl.searchParams.get('max_side')).toBe('1400');
    expect(ocrUrl.searchParams.get('document_crop')).toBe('true');
    const resultResponse = await handler.fetch(
      new Request(`https://tools.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const result = (await resultResponse.json()) as { data: { converted: { status: string }; compressed: { status: string }; output: { filename: string }; ocr: unknown } };
    expect(result.data.converted).toMatchObject({ status: 'skipped' });
    expect(result.data.compressed).toMatchObject({ status: 'skipped' });
    expect(result.data.output).toMatchObject({ filename: 'receipt.png' });
  });

  it('creates async OCR jobs with mode and forwards it during processing', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('ocrMode', 'tiny');

    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };
    expect(env.rows.get(createBody.data.jobId)?.tool_options_json).toBe('{"ocrMode":"tiny"}');

    const fetchMock = vi.fn(async (_input: unknown) => Response.json(sampleOcrResult()));
    vi.stubGlobal('fetch', fetchMock);
    await processJob(env, createBody.data.jobId);

    expect(requestUrl(fetchMock.mock.calls[0]![0]).pathname).toBe('/internal/ocr/image');
    expect(requestUrl(fetchMock.mock.calls[0]![0]).searchParams.get('mode')).toBe('tiny');
  });

  it('queues async jobs through TOOLS_JOBS when workflow is not configured', async () => {
    const env = fakeEnv();
    delete env.TOOLS_WORKFLOW;
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    const body = (await response.json()) as { data: { jobId: string } };
    expect(response.status).toBe(202);
    expect(env.workflowCreates).toHaveLength(0);
    expect(env.queueMessages).toEqual([{ jobId: body.data.jobId }]);
  });

  it('rejects invalid async OCR modes with a structured validation error', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('ocrMode', 'precise');

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'ocrMode must be one of tiny, small, medium', retryable: false },
    });
  });

  it('rejects invalid PDF extraction modes with a structured validation error', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    form.append('pdfExtractionMode', 'structure');

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'pdfExtractionMode must be one of auto, text, ocr', retryable: false },
    });
  });

  it('ignores PDF extraction mode fields for image OCR requests', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('pdfExtractionMode', 'structure');

    const response = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );

    const body = (await response.json()) as { data: { jobId: string } };
    expect(response.status).toBe(202);
    expect(env.rows.get(body.data.jobId)?.tool_options_json).toBe('{"ocrMode":"small"}');
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

  it('returns OCR idempotency conflict when the same key is reused with a different mode', async () => {
    const env = fakeEnv();
    const firstForm = new FormData();
    firstForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    firstForm.append('ocrMode', 'tiny');
    const firstResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'ocr-mode-conflict' },
        body: firstForm,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);

    const secondForm = new FormData();
    secondForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    secondForm.append('ocrMode', 'medium');
    const conflictResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'ocr-mode-conflict' },
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
        new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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

  it('processes async PDFs through raw batch OCR and aggregates page fallback quality', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    form.append('ocrMode', 'small');
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      expect(init?.body).toBeInstanceOf(ReadableStream);
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/pdf');
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json(pdfInfo(2, []));
      if (url.pathname === '/internal/ocr/pdf-batch') {
        expect(url.searchParams.get('start_page')).toBe('0');
        expect(url.searchParams.get('page_count')).toBe('2');
        expect(url.searchParams.get('mode')).toBe('small');
        return Response.json(samplePdfBatchResult());
      }
      throw new Error(`unexpected engine endpoint: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, createBody.data.jobId);

    const paths = fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname);
    expect(paths).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-batch']);
    expect(paths).not.toContain('/internal/ocr/pdf-page');

    const resultResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(resultResponse.status).toBe(200);
    const resultBody = (await resultResponse.json()) as { data: { extractionMethod: string; fallbackUsed: boolean; quality: { fallbackReasons: string[]; lowQualityPageCount: number }; timingsMs: Record<string, number>; metadata: Record<string, unknown> } };
    expect(resultBody.data.extractionMethod).toBe('ocr');
    expect(resultBody.data.metadata.pdfExtractionMode).toBe('auto');
    expect(resultBody.data.fallbackUsed).toBe(true);
    expect(resultBody.data.quality.fallbackReasons).toEqual(expect.arrayContaining(['short_text', 'low_confidence']));
    expect(resultBody.data.quality.lowQualityPageCount).toBe(1);
    expect(resultBody.data.timingsMs.requestedTotal).toBe(21);
    expect(resultBody.data.timingsMs.fallbackTotal).toBe(8);
  });

  it('extracts text-layer PDFs without calling OCR batches in auto mode', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json(pdfInfo(2, [0, 1]));
      if (url.pathname === '/internal/ocr/pdf-text-batch') {
        expect(url.searchParams.get('start_page')).toBe('0');
        expect(url.searchParams.get('page_count')).toBe('2');
        return Response.json(samplePdfTextBatchResult(0, 2));
      }
      throw new Error(`unexpected engine endpoint: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, createBody.data.jobId);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-text-batch']);
    const resultResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const resultBody = (await resultResponse.json()) as { data: { extractionMethod: string; pages: Array<{ extractionMethod: string }>; timingsMs: Record<string, number> } };
    expect(resultBody.data.extractionMethod).toBe('pdf_text');
    expect(resultBody.data.pages.every((page) => page.extractionMethod === 'pdf_text')).toBe(true);
    expect(resultBody.data.timingsMs.extractText).toBe(4);
  });

  it('processes mixed PDFs with text extraction and OCR in one job', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json(pdfInfo(2, [0]));
      if (url.pathname === '/internal/ocr/pdf-text-batch') {
        expect(url.searchParams.get('start_page')).toBe('0');
        expect(url.searchParams.get('page_count')).toBe('1');
        return Response.json(samplePdfTextBatchResult(0, 1));
      }
      if (url.pathname === '/internal/ocr/pdf-batch') {
        expect(url.searchParams.get('start_page')).toBe('1');
        expect(url.searchParams.get('page_count')).toBe('1');
        return Response.json(samplePdfBatchResult(1, 1));
      }
      throw new Error(`unexpected engine endpoint: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, createBody.data.jobId);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)).toEqual([
      '/internal/ocr/pdf-info',
      '/internal/ocr/pdf-text-batch',
      '/internal/ocr/pdf-batch',
    ]);
    const resultResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const resultBody = (await resultResponse.json()) as { data: { extractionMethod: string; pages: Array<{ extractionMethod: string }> } };
    expect(resultBody.data.extractionMethod).toBe('mixed');
    expect(resultBody.data.pages.map((page) => page.extractionMethod)).toEqual(['pdf_text', 'ocr']);
  });

  it('honors pdfExtractionMode=ocr by skipping text extraction', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    form.append('pdfExtractionMode', 'ocr');
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json(pdfInfo(1, [0]));
      if (url.pathname === '/internal/ocr/pdf-batch') return Response.json(samplePdfBatchResult(0, 1));
      throw new Error(`unexpected engine endpoint: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, createBody.data.jobId);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-batch']);
    const resultResponse = await handler.fetch(
      new Request(`https://ocr.test/v1/jobs/${createBody.data.jobId}/result`, {
        headers: { Authorization: 'Bearer dev-key' },
      }),
      env,
      {} as ExecutionContext,
    );
    const resultBody = (await resultResponse.json()) as { data: { extractionMethod: string; metadata: Record<string, unknown> } };
    expect(resultBody.data.extractionMethod).toBe('ocr');
    expect(resultBody.data.metadata.pdfExtractionMode).toBe('ocr');
  });

  it('fails text-only PDF extraction when a page has no usable text layer', async () => {
    const env = fakeEnv({ MAX_JOB_ATTEMPTS: '1' });
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    form.append('pdfExtractionMode', 'text');
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    vi.stubGlobal('fetch', vi.fn(async () => Response.json(pdfInfo(2, [0]))));

    await processJob(env, createBody.data.jobId);

    expect(env.rows.get(createBody.data.jobId)).toMatchObject({
      status: 'failed',
      result_r2_key: null,
    });
    expect(env.rows.get(createBody.data.jobId)?.error).toContain('has no usable text layer');
  });

  it('includes pdfExtractionMode in OCR idempotency fingerprints', async () => {
    const env = fakeEnv();
    const firstForm = new FormData();
    firstForm.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    firstForm.append('pdfExtractionMode', 'auto');
    const firstResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pdf-extraction-conflict' },
        body: firstForm,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(firstResponse.status).toBe(202);

    const secondForm = new FormData();
    secondForm.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    secondForm.append('pdfExtractionMode', 'ocr');
    const conflictResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pdf-extraction-conflict' },
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

  it('stops async PDF processing between batches when cancellation is requested', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('pdfs/mixed-two-page.pdf', 'application/pdf'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-key' },
        body: form,
      }),
      env,
      {} as ExecutionContext,
    );
    const createBody = (await createResponse.json()) as { data: { jobId: string } };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json(pdfInfo(6, []));
      if (url.pathname === '/internal/ocr/pdf-batch') {
        expect(url.searchParams.get('start_page')).toBe('0');
        const row = env.rows.get(createBody.data.jobId)!;
        row.status = 'cancel_requested';
        row.stage = 'cancel_requested';
        return Response.json(samplePdfBatchResult(0, 5));
      }
      throw new Error(`unexpected engine endpoint: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, createBody.data.jobId);

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-batch']);
    expect(env.rows.get(createBody.data.jobId)).toMatchObject({ status: 'cancelled', stage: 'cancelled', result_r2_key: null });
  });

  it('returns stable result errors for terminal and missing-result states', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const createResponse = await handler.fetch(
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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
      new Request('https://ocr.test/v1/tools/ocr', {
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

function requestUrl(input: unknown): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

async function pipelineForm(options: {
  file?: File;
  pipeline?: unknown;
  metadata?: Record<string, unknown>;
} = {}) {
  const form = new FormData();
  form.append('file', options.file ?? await fixtureFile('images/receipt.png', 'image/png'));
  if ('pipeline' in options) form.append('pipeline', JSON.stringify(options.pipeline));
  if (options.metadata) form.append('metadata', JSON.stringify(options.metadata));
  return form;
}

function pdfInfo(pageCount: number, textPages: number[]) {
  return {
    pageCount,
    pages: Array.from({ length: pageCount }, (_, pageIndex) => ({
      pageIndex,
      hasTextLayer: textPages.includes(pageIndex),
      textLength: textPages.includes(pageIndex) ? 64 : 0,
    })),
  };
}

function samplePdfTextBatchResult(startPage = 0, pageCount = 1) {
  const pages = Array.from({ length: pageCount }, (_, offset) => {
    const pageIndex = startPage + offset;
    return {
      pageIndex,
      width: 612,
      height: 792,
      text: `Embedded PDF text page ${pageIndex + 1}`,
      blocks: [{ text: `Embedded PDF text page ${pageIndex + 1}`, bbox: [0, 0, 200, 20], confidence: null }],
      tables: [],
      confidence: null,
      extractionMethod: 'pdf_text',
      timingsMs: { extractText: 2, total: 2 },
    };
  });
  const timingsMs = { extractText: pages.length * 2, total: pages.length * 2 };
  return {
    engine: 'mock',
    engineVersion: '1',
    document: { type: 'pdf', filename: 'mixed-two-page.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    pages,
    plainText: pages.map((page) => page.text).join('\n\n'),
    markdown: pages.map((page) => `## Page ${page.pageIndex + 1}\n\n${page.text}`).join('\n\n'),
    extractionMethod: 'pdf_text',
    timingsMs,
    metadata: {
      extractionMethod: 'pdf_text',
      timingsMs,
    },
  };
}

function samplePdfBatchResult(startPage = 0, pageCount = 2) {
  const pages = Array.from({ length: pageCount }, (_, offset) => {
    const pageIndex = startPage + offset;
    return {
      pageIndex,
      width: 100,
      height: 100,
      text: `PDF page ${pageIndex + 1} recognized text with enough words`,
      blocks: [{ text: `PDF page ${pageIndex + 1} recognized text with enough words`, confidence: 0.95 }],
      tables: [],
      confidence: 0.95,
      ocrMode: pageIndex === 0 ? 'medium' : 'small',
      requestedOcrMode: 'small',
      fallbackUsed: pageIndex === 0,
      quality:
        pageIndex === 0
          ? {
              lowQuality: false,
              reasons: [],
              fallbackReasons: ['short_text', 'low_confidence'],
              initial: { lowQuality: true, reasons: ['short_text', 'low_confidence'], fallbackReasons: ['short_text', 'low_confidence'] },
            }
          : { lowQuality: false, reasons: [], fallbackReasons: [] },
      timingsMs:
        pageIndex === 0
          ? { decode: 1, preprocess: 2, modelInit: 3, ocr: 10, normalize: 1, total: 20, requestedTotal: 12, fallbackTotal: 8 }
          : { decode: 1, preprocess: 2, modelInit: 0, ocr: 5, normalize: 1, total: 9, requestedTotal: 9, fallbackTotal: 0 },
    };
  });
  return {
    engine: 'mock',
    engineVersion: '1',
    document: { type: 'pdf', filename: 'mixed-two-page.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    pages,
    plainText: pages.map((page) => page.text).join('\n\n'),
    markdown: pages.map((page) => `## Page ${page.pageIndex + 1}\n\n${page.text}`).join('\n\n'),
    ocrMode: pages.some((page) => page.fallbackUsed) ? 'medium' : 'small',
    requestedOcrMode: 'small',
    fallbackUsed: pages.some((page) => page.fallbackUsed),
    quality: { lowQuality: false, reasons: [], fallbackReasons: ['short_text', 'low_confidence'] },
    timingsMs: { requestedTotal: 21, fallbackTotal: 8, total: 29 },
  };
}
