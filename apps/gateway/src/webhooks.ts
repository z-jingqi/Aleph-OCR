import {
  listDueWebhookDeliveries,
  markWebhookDelivered,
  markWebhookFailed,
  type WebhookDelivery,
} from './job-store';
import { toHex } from './http/idempotency';
import type { Env } from './types';

export async function deliverDueWebhooks(env: Env & { DB: D1Database }) {
  const deliveries = await listDueWebhookDeliveries(env);
  await Promise.all(deliveries.map((delivery) => deliverWebhook(env, delivery)));
}

async function deliverWebhook(env: Env & { DB: D1Database }, delivery: WebhookDelivery) {
  const body = JSON.stringify(delivery.payload);
  const timestamp = new Date().toISOString();
  try {
    const signature = await signWebhook(env, timestamp, body);
    const response = await fetch(new Request(delivery.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aleph-Tools-Event-Id': delivery.eventId,
        'X-Aleph-Tools-Delivery-Id': delivery.deliveryId,
        'X-Aleph-Tools-Timestamp': timestamp,
        'X-Aleph-Tools-Signature': signature,
      },
      body,
    }));
    if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
    await markWebhookDelivered(env, delivery.deliveryId);
  } catch (error) {
    await markWebhookFailed(env, delivery, error instanceof Error ? error.message : 'Webhook delivery failed');
  }
}

async function signWebhook(env: Env, timestamp: string, body: string): Promise<string> {
  const secret = env.WEBHOOK_SIGNING_SECRET;
  if (!secret) throw new Error('WEBHOOK_SIGNING_SECRET is not configured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${toHex(signature)}`;
}
