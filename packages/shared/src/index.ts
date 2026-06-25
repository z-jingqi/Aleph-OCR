import { z } from 'zod';

export const ALEPH_OCR_VERSION = '0.1.0';
export const MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const PDF_BATCH_SIZE = 5;
export const PDF_RENDER_DPI = 200;

export const DocumentTypeSchema = z.enum(['image', 'pdf']);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const JobStatusSchema = z.enum(['queued', 'processing', 'cancel_requested', 'cancelled', 'ready', 'failed', 'deleted']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobStageSchema = z.enum([
  'queued',
  'processing',
  'reading_source',
  'planning_pages',
  'ocr',
  'storing_page',
  'storing_result',
  'cancel_requested',
  'cancelled',
  'ready',
  'failed',
  'deleted',
]);
export type JobStage = z.infer<typeof JobStageSchema>;

export const OcrJobPageStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed', 'cancelled']);
export type OcrJobPageStatus = z.infer<typeof OcrJobPageStatusSchema>;

export const OcrDocumentSchema = z.object({
  type: DocumentTypeSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type OcrDocument = z.infer<typeof OcrDocumentSchema>;

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

export const OcrResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  engine: z.string(),
  engineVersion: z.string(),
  document: OcrDocumentSchema,
  pages: z.array(OcrPageSchema),
  plainText: z.string(),
  markdown: z.string(),
});
export type OcrResult = z.infer<typeof OcrResultSchema>;

export const OcrJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100).default(0),
  stage: JobStageSchema.optional(),
  currentPage: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  document: OcrDocumentSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});
export type OcrJob = z.infer<typeof OcrJobSchema>;

export const OcrJobEventTypeSchema = z.enum([
  'job.created',
  'job.status',
  'job.progress',
  'job.page.ready',
  'job.ready',
  'job.failed',
  'job.cancel_requested',
  'job.cancelled',
  'job.deleted',
]);
export type OcrJobEventType = z.infer<typeof OcrJobEventTypeSchema>;

export const OcrJobEventSchema = z.object({
  eventId: z.string(),
  jobId: z.string(),
  sequence: z.number().int().positive(),
  type: OcrJobEventTypeSchema,
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type OcrJobEvent = z.infer<typeof OcrJobEventSchema>;

export const WebhookDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookCallbackSchema = z.object({
  url: z.string().url(),
  metadata: z.record(z.unknown()).optional(),
});
export type WebhookCallback = z.infer<typeof WebhookCallbackSchema>;

export const EngineInfoSchema = z.object({
  engine: z.string(),
  engineVersion: z.string(),
  capabilities: z.object({
    image: z.boolean(),
    pdf: z.boolean(),
    syncImage: z.boolean(),
    asyncJobs: z.boolean(),
    layout: z.boolean(),
    tables: z.boolean(),
  }),
  limits: z.object({
    maxSyncImageSizeBytes: z.number().int(),
    maxPdfPages: z.number().int(),
    pdfBatchSize: z.number().int(),
    pdfRenderDpi: z.number().int(),
  }),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

export function isSupportedImageMime(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp'].includes(mimeType);
}

export function isSupportedPdfMime(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

export function inferDocumentType(mimeType: string): DocumentType | null {
  if (isSupportedImageMime(mimeType)) return 'image';
  if (isSupportedPdfMime(mimeType)) return 'pdf';
  return null;
}
