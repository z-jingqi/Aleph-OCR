import { z } from 'zod';
import { OcrDocumentSchema } from './documents';
import { JobStatusSchema } from './jobs';

export const OcrProviderSchema = z.literal('google-vision');
export type OcrProvider = z.infer<typeof OcrProviderSchema>;

export const OcrBlockSchema = z.object({
  text: z.string(),
  bbox: z.array(z.number()).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type OcrBlock = z.infer<typeof OcrBlockSchema>;

export const OcrTableSchema = z.object({
  bbox: z.array(z.number()).optional(),
  markdown: z.string().optional(),
  cells: z.array(z.unknown()).optional(),
});
export type OcrTable = z.infer<typeof OcrTableSchema>;

export const OcrPageSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  text: z.string(),
  blocks: z.array(OcrBlockSchema),
  tables: z.array(OcrTableSchema),
  confidence: z.number().min(0).max(1).nullable(),
});
export type OcrPage = z.infer<typeof OcrPageSchema>;

export const OcrTimingsMsSchema = z.object({
  convert: z.number().nonnegative().optional(),
  googleVision: z.number().nonnegative().optional(),
  normalize: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
}).catchall(z.number().nonnegative());
export type OcrTimingsMs = z.infer<typeof OcrTimingsMsSchema>;

export const OcrInputSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  converted: z.boolean(),
  originalMimeType: z.string().optional(),
});
export type OcrInput = z.infer<typeof OcrInputSchema>;

export const OcrResultMetadataSchema = z.object({
  provider: OcrProviderSchema,
  feature: z.literal('DOCUMENT_TEXT_DETECTION'),
  input: OcrInputSchema,
  timingsMs: OcrTimingsMsSchema.optional(),
}).catchall(z.unknown());
export type OcrResultMetadata = z.infer<typeof OcrResultMetadataSchema>;

export const OcrResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  engine: z.literal('google-vision'),
  engineVersion: z.string(),
  document: OcrDocumentSchema,
  pages: z.array(OcrPageSchema),
  plainText: z.string(),
  markdown: z.string(),
  metadata: OcrResultMetadataSchema,
});
export type OcrResult = z.infer<typeof OcrResultSchema>;
