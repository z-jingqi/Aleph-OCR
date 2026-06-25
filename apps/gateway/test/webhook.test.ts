import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, requestJobCancel } from '../src/job-store';
import { processJob } from '../src/index';
import { fakeEnv, sampleOcrResult } from './helpers';
import type { OcrDocument } from '@aleph-ocr/shared';

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
    expect(webhookRequest?.headers.get('X-Aleph-OCR-Event-Id')).toBe(delivery.event_id);
    expect(webhookRequest?.headers.get('X-Aleph-OCR-Signature')).toMatch(/^sha256=[a-f0-9]{64}$/);

    const body = await webhookRequest!.text();
    const timestamp = webhookRequest!.headers.get('X-Aleph-OCR-Timestamp')!;
    await expect(verifySignature(env.WEBHOOK_SIGNING_SECRET, timestamp, body, webhookRequest!.headers.get('X-Aleph-OCR-Signature')!)).resolves.toBe(
      true,
    );
    expect(JSON.parse(body)).toMatchObject({
      event: 'ocr.job.ready',
      jobId: job.jobId,
      metadata: { documentId: 'doc_123' },
      resultUrl: `/v1/jobs/${job.jobId}/result`,
    });
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
    });
  });
});

async function verifySignature(secret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = `sha256=${[...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return expected === signature;
}
