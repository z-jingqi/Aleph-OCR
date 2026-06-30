import { z } from 'zod';

export const EngineInfoSchema = z.object({
  engine: z.literal('google-vision'),
  engineVersion: z.string(),
  provider: z.literal('google-vision'),
  feature: z.literal('DOCUMENT_TEXT_DETECTION'),
  capabilities: z.object({
    image: z.boolean(),
    pdf: z.boolean(),
    autoImageConversion: z.boolean(),
    asyncJobs: z.boolean(),
    layout: z.boolean(),
    tables: z.boolean(),
  }),
  limits: z.object({
    maxSyncImageSizeBytes: z.number().int(),
    maxImageUploadBytes: z.number().int(),
  }),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;
