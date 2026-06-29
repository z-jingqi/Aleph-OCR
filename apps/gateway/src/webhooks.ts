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
    const signature = await signWebhook(env, delivery.clientId, timestamp, body);
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

async function signWebhook(env: Env, clientId: string, timestamp: string, body: string): Promise<string> {
  const secret = webhookSigningSecretForClient(env, clientId);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${toHex(signature)}`;
}

export function parseWebhookSigningSecrets(raw: string | undefined): Map<string, string> {
  const secrets = new Map<string, string>();
  if (!raw) return secrets;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return secrets;
  for (const [clientId, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof secret === 'string' && secret.length > 0) secrets.set(clientId, secret);
  }
  return secrets;
}

function webhookSigningSecretForClient(env: Env, clientId: string): string {
  let secrets: Map<string, string>;
  try {
    secrets = parseWebhookSigningSecrets(env.ALEPH_TOOLS_WEBHOOK_SECRETS);
  } catch {
    throw new Error('ALEPH_TOOLS_WEBHOOK_SECRETS must be a JSON object');
  }
  const secret = secrets.get(clientId);
  if (!secret) throw new Error(`Webhook signing secret is not configured for client ${clientId}`);
  return secret;
}
