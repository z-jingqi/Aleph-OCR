import { z } from 'zod';

export const ALEPH_TOOLS_VERSION = '0.1.0';
export const ALEPH_OCR_VERSION = ALEPH_TOOLS_VERSION;
export const MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const PDF_BATCH_SIZE = 5;
export const PDF_RENDER_DPI = 200;

export const ToolTypeSchema = z.enum(['ocr', 'image.convert']);
export type ToolType = z.infer<typeof ToolTypeSchema>;

export const DocumentTypeSchema = z.enum(['image', 'pdf']);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const OcrModeValues = ['fast', 'balanced', 'accurate'] as const;
export const OcrModeSchema = z.enum(OcrModeValues).default('balanced');
export type OcrMode = z.infer<typeof OcrModeSchema>;
export const DEFAULT_OCR_MODE: OcrMode = 'balanced';

export const JobStatusSchema = z.enum(['queued', 'processing', 'cancel_requested', 'cancelled', 'ready', 'failed', 'deleted']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'STORAGE_UNAVAILABLE',
  'WORKFLOW_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNSUPPORTED_FORMAT',
  'FILE_TOO_LARGE',
  'JOB_NOT_FOUND',
  'JOB_NOT_READY',
  'JOB_FAILED',
  'JOB_CANCELLED',
  'JOB_DELETED',
  'RESULT_NOT_FOUND',
  'OUTPUT_NOT_FOUND',
  'CANCEL_NOT_ALLOWED',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  httpStatus: z.number().int(),
  requestId: z.string(),
  jobId: z.string().optional(),
  jobStatus: JobStatusSchema.optional(),
  stage: z.string().optional(),
  retryable: z.boolean(),
  terminal: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

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
  ocrMode: OcrModeSchema.optional(),
  requestedOcrMode: OcrModeSchema.optional(),
  fallbackUsed: z.boolean().optional(),
  preprocessedWidth: z.number().int().positive().optional(),
  preprocessedHeight: z.number().int().positive().optional(),
  quality: z.unknown().optional(),
  timingsMs: z.record(z.number().nonnegative()).optional(),
});
export type OcrPage = z.infer<typeof OcrPageSchema>;

export const OcrQualitySchema = z.object({
  score: z.number().min(0).max(1).nullable().optional(),
  lowQuality: z.boolean().optional(),
  reasons: z.array(z.string()).optional(),
  fallbackReasons: z.array(z.string()).optional(),
  blockCount: z.number().int().nonnegative().optional(),
  validTextLength: z.number().int().nonnegative().optional(),
  effectiveTextLength: z.number().int().nonnegative().optional(),
  avgConfidence: z.number().min(0).max(1).nullable().optional(),
  averageConfidence: z.number().min(0).max(1).nullable().optional(),
  numericRatio: z.number().min(0).max(1).optional(),
  tableNumericLike: z.boolean().optional(),
  pageCount: z.number().int().nonnegative().optional(),
  lowQualityPageCount: z.number().int().nonnegative().optional(),
}).catchall(z.unknown());
export type OcrQuality = z.infer<typeof OcrQualitySchema>;

export const OcrTimingsMsSchema = z.object({
  decode: z.number().nonnegative().optional(),
  preprocess: z.number().nonnegative().optional(),
  modelInit: z.number().nonnegative().optional(),
  ocr: z.number().nonnegative().optional(),
  normalize: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  requestedTotal: z.number().nonnegative().optional(),
  fallbackTotal: z.number().nonnegative().optional(),
}).catchall(z.number().nonnegative());
export type OcrTimingsMs = z.infer<typeof OcrTimingsMsSchema>;

export const OcrResultMetadataSchema = z.object({
  ocrMode: OcrModeSchema.optional(),
  requestedOcrMode: OcrModeSchema.optional(),
  fallbackUsed: z.boolean().optional(),
  quality: OcrQualitySchema.optional(),
  timingsMs: OcrTimingsMsSchema.optional(),
}).catchall(z.unknown());
export type OcrResultMetadata = z.infer<typeof OcrResultMetadataSchema>;

export const OcrResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  engine: z.string(),
  engineVersion: z.string(),
  document: OcrDocumentSchema,
  pages: z.array(OcrPageSchema),
  plainText: z.string(),
  markdown: z.string(),
  ocrMode: OcrModeSchema.optional(),
  requestedOcrMode: OcrModeSchema.optional(),
  fallbackUsed: z.boolean().optional(),
  quality: OcrQualitySchema.optional(),
  timingsMs: OcrTimingsMsSchema.optional(),
  metadata: OcrResultMetadataSchema.optional(),
});
export type OcrResult = z.infer<typeof OcrResultSchema>;

export const ImageConvertFormatSchema = z.enum(['png', 'jpeg', 'webp', 'avif']);
export type ImageConvertFormat = z.infer<typeof ImageConvertFormatSchema>;

export const ImageConvertFitSchema = z.enum(['contain', 'cover', 'inside']);
export type ImageConvertFit = z.infer<typeof ImageConvertFitSchema>;

export const ImageConvertOptionsSchema = z.object({
  targetFormat: ImageConvertFormatSchema,
  quality: z.number().int().min(1).max(100).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fit: ImageConvertFitSchema.default('inside'),
});
export type ImageConvertOptions = z.infer<typeof ImageConvertOptionsSchema>;

export const ImageConvertOutputSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: ImageConvertFormatSchema,
  resultUrl: z.string(),
});
export type ImageConvertOutput = z.infer<typeof ImageConvertOutputSchema>;

export const ImageConvertResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  tool: z.literal('image.convert'),
  output: ImageConvertOutputSchema,
  metadata: z.record(z.unknown()).optional(),
});
export type ImageConvertResult = z.infer<typeof ImageConvertResultSchema>;

export const ToolResultSchema = z.union([OcrResultSchema, ImageConvertResultSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const OcrJobSchema = z.object({
  jobId: z.string(),
  tool: ToolTypeSchema.optional(),
  operation: z.string().optional(),
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
  terminal: z.boolean().optional(),
  cancelable: z.boolean().optional(),
  retryable: z.boolean().optional(),
  resultAvailable: z.boolean().optional(),
  outputAvailable: z.boolean().optional(),
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

export const EngineInfoSchema = z.preprocess(normalizeEngineInfoInput, z.object({
  engine: z.string(),
  engineVersion: z.string(),
  modes: z.array(OcrModeSchema).default([...OcrModeValues]),
  defaultMode: OcrModeSchema.default('balanced'),
  modeConfig: z.record(z.unknown()).default({}),
  ocrModes: z.array(OcrModeSchema).default([...OcrModeValues]),
  defaultOcrMode: OcrModeSchema.default('balanced'),
  modeConfigs: z.record(z.unknown()).default({}),
  capabilities: z.object({
    image: z.boolean(),
    pdf: z.boolean(),
    syncImage: z.boolean(),
    imageConvert: z.boolean().optional(),
    imageConvertFormats: z.array(ImageConvertFormatSchema).optional(),
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
}));
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

function normalizeEngineInfoInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const modes = record.modes ?? record.ocrModes;
  const defaultMode = record.defaultMode ?? record.defaultOcrMode;
  const modeConfig = record.modeConfig ?? record.modeConfigs;
  return {
    ...record,
    modes,
    defaultMode,
    modeConfig,
    ocrModes: record.ocrModes ?? modes,
    defaultOcrMode: record.defaultOcrMode ?? defaultMode,
    modeConfigs: record.modeConfigs ?? modeConfig,
  };
}

export function isSupportedImageMime(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp', 'image/heic', 'image/heif'].includes(mimeType);
}

export function isSupportedPdfMime(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

export function inferDocumentType(mimeType: string): DocumentType | null {
  if (isSupportedImageMime(mimeType)) return 'image';
  if (isSupportedPdfMime(mimeType)) return 'pdf';
  return null;
}
