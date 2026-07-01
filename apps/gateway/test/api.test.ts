import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/index';
import { fakeEnv, fixtureFile, sampleGoogleVisionResponse, type FakeGatewayEnv } from './helpers';

describe('gateway API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves health and engine info', async () => {
    const env = fakeEnv();
    const health = await handler.fetch(new Request('https://tools.test/health'), env);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', service: 'aleph-tools-gateway' });

    const engine = await handler.fetch(new Request('https://tools.test/v1/engines', {
      headers: { Authorization: 'Bearer dev-key' },
    }), env);
    expect(engine.status).toBe(200);
    await expect(engine.json()).resolves.toMatchObject({
      success: true,
      data: { engine: 'google-vision', capabilities: { image: true, pdf: false, autoImageConversion: true } },
    });
  });

  it('runs synchronous OCR for Google Vision native image formats', async () => {
    const env = fakeEnv();
    const fetchMock = vi.fn(async () => Response.json(sampleGoogleVisionResponse('native image text')));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key' },
      body: form,
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { engine: 'google-vision', plainText: 'native image text', metadata: { input: { converted: false } } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs synchronous OCR for Android RAW/DNG without conversion', async () => {
    const env = fakeEnv();
    const fetchMock = vi.fn(async () => Response.json(sampleGoogleVisionResponse('raw image text')));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', new File(['dng-bytes'], 'camera-pro-mode.dng', { type: 'image/x-adobe-dng' }));

    const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key' },
      body: form,
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        document: { filename: 'camera-pro-mode.dng', mimeType: 'image/x-adobe-dng' },
        metadata: { input: { converted: false } },
        plainText: 'raw image text',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('automatically converts HEIC before synchronous OCR', async () => {
    const env = fakeEnv();
    const fetchMock = vi.fn(async () => Response.json(sampleGoogleVisionResponse('converted receipt text')));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', await fixtureFile('images/IMG_4706.HEIC', 'image/heic'));

    const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key' },
      body: form,
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { document: { mimeType: 'image/jpeg' }, metadata: { input: { converted: true, originalMimeType: 'image/heic' } } },
    });
  });

  it('creates async OCR jobs with idempotency', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const first = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'receipt-1' },
      body: form,
    }), env);
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { data: { jobId: string } };
    expect(firstBody.data).toMatchObject({ status: 'queued', tool: 'ocr', operation: 'ocr' });
    expect(env.workflowCreates).toHaveLength(1);

    const secondForm = new FormData();
    secondForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const second = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'receipt-1' },
      body: secondForm,
    }), env);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ data: { jobId: firstBody.data.jobId } });
  });

  it('serves the stored source image to the owning client', async () => {
    const env = fakeEnv();
    const jobId = await createAsyncJob(env, new File(['source-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const response = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}/source`, {
      headers: { Authorization: 'Bearer dev-key' },
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toContain('filename="receipt.jpg"');
    await expect(response.text()).resolves.toBe('source-bytes');
  });

  it('does not serve source images across clients', async () => {
    const env = fakeEnv();
    const jobId = await createAsyncJob(env, new File(['source-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const response = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}/source`, {
      headers: { Authorization: 'Bearer other-key' },
    }), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
  });

  it('does not serve source images after deletion', async () => {
    const env = fakeEnv();
    const jobId = await createAsyncJob(env, new File(['source-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const deleted = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev-key' },
    }), env);
    expect(deleted.status).toBe(200);

    const response = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}/source`, {
      headers: { Authorization: 'Bearer dev-key' },
    }), env);
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'JOB_DELETED' } });
  });

  it('reports a missing source object as a consistency error', async () => {
    const env = fakeEnv();
    const jobId = await createAsyncJob(env, new File(['source-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));
    env.objects.clear();

    const response = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}/source`, {
      headers: { Authorization: 'Bearer dev-key' },
    }), env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SOURCE_NOT_FOUND', retryable: true, terminal: true },
    });
  });

  it('does not expose source thumbnail routes', async () => {
    const env = fakeEnv();
    const jobId = await createAsyncJob(env, new File(['source-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const response = await handler.fetch(new Request(`https://tools.test/v1/jobs/${jobId}/source/thumbnail`, {
      headers: { Authorization: 'Bearer dev-key' },
    }), env);

    expect(response.status).toBe(404);
  });

  it('abandons unstarted jobs when workflow start fails so idempotent retries can create a new job', async () => {
    const env = fakeEnv({
      TOOLS_WORKFLOW: {
        async create() {
          throw new Error('workflow down');
        },
      } as unknown as Workflow<{ jobId: string }>,
    });
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));

    const failed = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'retryable-start' },
      body: form,
    }), env);

    expect(failed.status).toBe(500);
    expect([...env.rows.values()]).toHaveLength(1);
    expect([...env.rows.values()][0]).toMatchObject({
      status: 'deleted',
      stage: 'deleted',
      idempotency_key: null,
      idempotency_fingerprint: null,
    });
    expect(env.objects.size).toBe(0);

    env.TOOLS_WORKFLOW = {
      async create(options: { id?: string; params?: { jobId: string } }) {
        env.workflowCreates.push(options);
        return {} as WorkflowInstance;
      },
    } as unknown as Workflow<{ jobId: string }>;
    const retryForm = new FormData();
    retryForm.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    const retry = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'retryable-start' },
      body: retryForm,
    }), env);

    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({ data: { status: 'queued' } });
    expect(env.workflowCreates).toHaveLength(1);
  });

  it('rejects PDF and unsupported image formats', async () => {
    const env = fakeEnv();
    const pdfForm = new FormData();
    pdfForm.append('file', new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }));

    const pdfResponse = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'pdf' },
      body: pdfForm,
    }), env);
    expect(pdfResponse.status).toBe(400);
    await expect(pdfResponse.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });

    const svgForm = new FormData();
    svgForm.append('file', new File(['<svg />'], 'icon.svg', { type: 'image/svg+xml' }));
    const svgResponse = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'svg' },
      body: svgForm,
    }), env);
    expect(svgResponse.status).toBe(400);
    await expect(svgResponse.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_FORMAT' } });

    const avifForm = new FormData();
    avifForm.append('file', new File(['avif'], 'photo.avif', { type: 'image/avif' }));
    const avifResponse = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'avif' },
      body: avifForm,
    }), env);
    expect(avifResponse.status).toBe(400);
    await expect(avifResponse.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_FORMAT' } });
  });

  it('rejects removed OCR configuration fields', async () => {
    const env = fakeEnv();
    const form = new FormData();
    const removedField = ['ocr', 'Mode'].join('');
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append(removedField, 'small');

    const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'removed-field' },
      body: form,
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: `Unsupported OCR upload field: ${removedField}` },
    });
  });

  it('rejects oversized metadata fields', async () => {
    const env = fakeEnv();
    const form = new FormData();
    form.append('file', await fixtureFile('images/receipt.png', 'image/png'));
    form.append('metadata', JSON.stringify({ value: 'x'.repeat(4096) }));

    const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key', 'Idempotency-Key': 'large-metadata' },
      body: form,
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'metadata must be 4096 bytes or fewer' },
    });
  });

  it('does not expose removed image tool routes', async () => {
    const env = fakeEnv();
    const response = await handler.fetch(new Request('https://tools.test/v1/tools/image/compress', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-key' },
    }), env);
    expect(response.status).toBe(404);
  });
});

async function createAsyncJob(env: FakeGatewayEnv, file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);

  const response = await handler.fetch(new Request('https://tools.test/v1/tools/ocr', {
    method: 'POST',
    headers: { Authorization: 'Bearer dev-key' },
    body: form,
  }), env);

  expect(response.status).toBe(202);
  const body = await response.json() as { data: { jobId: string } };
  return body.data.jobId;
}
