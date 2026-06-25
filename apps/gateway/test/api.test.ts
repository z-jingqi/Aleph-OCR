import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/index';
import { fakeEnv, fixtureFile } from './helpers';

describe('gateway API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    const createBody = (await createResponse.json()) as { data: { jobId: string; status: string; progress: number } };
    expect(createBody.data).toMatchObject({ status: 'queued', progress: 0 });
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
      data: { jobId: createBody.data.jobId, progress: 0, stage: 'queued' },
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
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Idempotency-Key must be 256 characters or fewer' });
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
    await expect(resultResponse.json()).resolves.toMatchObject({ success: false, error: 'Job is queued' });
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
