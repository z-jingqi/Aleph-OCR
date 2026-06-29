import { z } from 'zod';
import { OcrDocumentSchema } from './documents';
import { JobStatusSchema } from './jobs';

export const OcrModeValues = ['tiny', 'small', 'medium'] as const;
export const OcrModeSchema = z.enum(OcrModeValues).default('small');
export type OcrMode = z.infer<typeof OcrModeSchema>;
export const DEFAULT_OCR_MODE: OcrMode = 'small';

export const PdfExtractionModeValues = ['auto', 'text', 'ocr'] as const;
export const PdfExtractionModeSchema = z.enum(PdfExtractionModeValues).default('auto');
export type PdfExtractionMode = z.infer<typeof PdfExtractionModeSchema>;
export const DEFAULT_PDF_EXTRACTION_MODE: PdfExtractionMode = 'auto';

export const ExtractionMethodValues = ['pdf_text', 'ocr', 'mixed'] as const;
export const ExtractionMethodSchema = z.enum(ExtractionMethodValues);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

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
  extractionMethod: z.enum(['pdf_text', 'ocr']).optional(),
  preprocessedWidth: z.number().int().positive().optional(),
  preprocessedHeight: z.number().int().positive().optional(),
  ocrInputMaxSide: z.number().int().positive().optional(),
  documentCropApplied: z.boolean().optional(),
  documentCropBbox: z.array(z.number()).optional(),
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
  extractText: z.number().nonnegative().optional(),
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
  pdfExtractionMode: PdfExtractionModeSchema.optional(),
  extractionMethod: ExtractionMethodSchema.optional(),
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
  extractionMethod: ExtractionMethodSchema.optional(),
  fallbackUsed: z.boolean().optional(),
  quality: OcrQualitySchema.optional(),
  timingsMs: OcrTimingsMsSchema.optional(),
  metadata: OcrResultMetadataSchema.optional(),
});
export type OcrResult = z.infer<typeof OcrResultSchema>;
