import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, requestJobCancel } from '../src/job-store';
import { processJob } from '../src/index';
import { fakeEnv, sampleOcrResult } from './helpers';
import type { OcrDocument } from '@aleph-tools/shared';

describe('webhook delivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs ready webhook deliveries and marks 2xx responses delivered', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
      callbackMetadata: { documentId: 'doc_123' },
    });
    let webhookRequest: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(sampleOcrResult(document)))
        .mockImplementationOnce(async (request: Request) => {
          webhookRequest = request;
          return new Response('ok', { status: 200 });
        }),
    );

    await processJob(env, job.jobId);

    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('delivered');
    expect(delivery.attempt_count).toBe(1);
    expect(webhookRequest?.headers.get('X-Aleph-Tools-Event-Id')).toBe(delivery.event_id);
    expect(webhookRequest?.headers.get('X-Aleph-Tools-Signature')).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect([...webhookRequest!.headers.keys()].some((name) => name.startsWith('x-aleph-') && name.includes('ocr'))).toBe(false);

    const body = await webhookRequest!.text();
    const timestamp = webhookRequest!.headers.get('X-Aleph-Tools-Timestamp')!;
    await expect(verifySignature('test-webhook-secret', timestamp, body, webhookRequest!.headers.get('X-Aleph-Tools-Signature')!)).resolves.toBe(
      true,
    );
    expect(JSON.parse(body)).toMatchObject({
      event: 'ocr.job.ready',
      jobId: job.jobId,
      metadata: { documentId: 'doc_123' },
      resultUrl: `/v1/jobs/${job.jobId}/result`,
    });
  });

  it('uses the webhook signing secret for the delivery client', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'other-client', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    let webhookRequest: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(sampleOcrResult(document)))
        .mockImplementationOnce(async (request: Request) => {
          webhookRequest = request;
          return new Response('ok', { status: 200 });
        }),
    );

    await processJob(env, job.jobId);

    const body = await webhookRequest!.text();
    const timestamp = webhookRequest!.headers.get('X-Aleph-Tools-Timestamp')!;
    const signature = webhookRequest!.headers.get('X-Aleph-Tools-Signature')!;
    await expect(verifySignature('other-webhook-secret', timestamp, body, signature)).resolves.toBe(true);
    await expect(verifySignature('test-webhook-secret', timestamp, body, signature)).resolves.toBe(false);
  });

  it('fails webhook delivery without calling callback when the client secret is missing', async () => {
    const env = fakeEnv({ ALEPH_TOOLS_WEBHOOK_SECRETS: '{"other-client":"other-webhook-secret"}' });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(sampleOcrResult(document)));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_error).toBe('Webhook signing secret is not configured for client example-client-dev');
    expect(delivery.next_attempt_at).toBeTruthy();
  });

  it('fails webhook delivery without calling callback when webhook secrets JSON is invalid', async () => {
    const env = fakeEnv({ ALEPH_TOOLS_WEBHOOK_SECRETS: 'not-json' });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(sampleOcrResult(document)));
    vi.stubGlobal('fetch', fetchMock);

    await processJob(env, job.jobId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_error).toBe('ALEPH_TOOLS_WEBHOOK_SECRETS must be a JSON object');
    expect(delivery.next_attempt_at).toBeTruthy();
  });

  it('records retry state for non-2xx responses without rolling back ready jobs', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(Response.json(sampleOcrResult(document))).mockResolvedValueOnce(new Response('nope', { status: 503 })),
    );

    await processJob(env, job.jobId);

    expect((await getJob(env, 'example-client-dev', job.jobId))?.status).toBe('ready');
    const delivery = [...env.deliveries.values()][0];
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_error).toBe('Webhook returned 503');
    expect(delivery.next_attempt_at).toBeTruthy();
  });

  it('sends structured failed webhook payloads', async () => {
    const env = fakeEnv({ MAX_JOB_ATTEMPTS: '1' });
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('engine unavailable', { status: 503 })));

    await processJob(env, job.jobId);

    const delivery = [...env.deliveries.values()][0];
    expect(JSON.parse(delivery.payload_json)).toMatchObject({
      event: 'ocr.job.failed',
      jobId: job.jobId,
      error: { code: 'JOB_FAILED', jobStatus: 'failed', retryable: false, terminal: true },
    });
  });

  it('creates cancelled webhook deliveries without rolling back cancellation', async () => {
    const env = fakeEnv();
    const document: OcrDocument = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 };
    const job = await createJob(env, 'example-client-dev', document, new File(['abc'], 'receipt.png', { type: 'image/png' }), {
      callbackUrl: 'https://app.test/ocr/webhook',
    });

    await requestJobCancel(env, 'example-client-dev', job.jobId);

    const delivery = [...env.deliveries.values()][0];
    expect(JSON.parse(delivery.payload_json)).toMatchObject({
      event: 'ocr.job.cancelled',
      jobId: job.jobId,
      error: { code: 'JOB_CANCELLED', jobStatus: 'cancelled', retryable: false, terminal: true },
    });
  });
});

async function verifySignature(secret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = `sha256=${[...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return expected === signature;
}
