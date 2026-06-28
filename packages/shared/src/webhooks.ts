import { z } from 'zod';

export const WebhookDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookCallbackSchema = z.object({
  url: z.string().url(),
  metadata: z.record(z.unknown()).optional(),
});
export type WebhookCallback = z.infer<typeof WebhookCallbackSchema>;
