import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/index';
import { fakeEnv, fixtureFile, sampleGoogleVisionResponse } from './helpers';

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
