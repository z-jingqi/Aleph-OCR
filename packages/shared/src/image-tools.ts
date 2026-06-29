import { z } from 'zod';
import { JobStatusSchema } from './jobs';
import { OcrResultSchema } from './ocr';

export const ImageConvertFormatSchema = z.enum(['png', 'jpeg', 'webp', 'avif']);
export type ImageConvertFormat = z.infer<typeof ImageConvertFormatSchema>;

export const ImageCompressFormatSchema = z.enum(['jpeg', 'webp']);
export type ImageCompressFormat = z.infer<typeof ImageCompressFormatSchema>;

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

const ImageCompressOptionsBaseSchema = z.object({
  targetSizeBytes: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  minQuality: z.number().int().min(1).max(100).default(45),
  maxQuality: z.number().int().min(1).max(100).default(85),
  outputFormat: ImageCompressFormatSchema.default('jpeg'),
});

export const ImageCompressOptionsSchema = ImageCompressOptionsBaseSchema.refine((value) => value.minQuality <= value.maxQuality, {
  message: 'minQuality must be less than or equal to maxQuality',
  path: ['minQuality'],
});
export type ImageCompressOptions = z.infer<typeof ImageCompressOptionsSchema>;

export const ImageCompressOutputSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  originalSizeBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  compressionRatio: z.number().nonnegative(),
  targetSizeBytes: z.number().int().positive().optional(),
  targetMet: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: ImageCompressFormatSchema,
  quality: z.number().int().min(1).max(100),
  resultUrl: z.string(),
});
export type ImageCompressOutput = z.infer<typeof ImageCompressOutputSchema>;

export const ImageCompressResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  tool: z.literal('image.compress'),
  output: ImageCompressOutputSchema,
  metadata: z.record(z.unknown()).optional(),
});
export type ImageCompressResult = z.infer<typeof ImageCompressResultSchema>;

export const ImagePipelineConvertOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  targetFormat: ImageConvertFormatSchema.default('jpeg'),
  quality: z.number().int().min(1).max(100).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fit: ImageConvertFitSchema.default('inside'),
}).default({
  enabled: true,
  targetFormat: 'jpeg',
  fit: 'inside',
});

export const ImagePipelineCompressOptionsSchema = ImageCompressOptionsBaseSchema.extend({
  enabled: z.boolean().default(true),
}).refine((value) => value.minQuality <= value.maxQuality, {
  message: 'minQuality must be less than or equal to maxQuality',
  path: ['minQuality'],
}).default({
  enabled: true,
  outputFormat: 'jpeg',
  targetSizeBytes: 350_000,
  maxWidth: 1000,
  maxHeight: 1000,
  minQuality: 45,
  maxQuality: 75,
});

export const ImagePipelineOptionsSchema = z.object({
  convert: ImagePipelineConvertOptionsSchema,
  compress: ImagePipelineCompressOptionsSchema,
  ocr: z.object({
    ocrMode: z.enum(['tiny', 'small', 'medium']).default('small'),
  }).default({ ocrMode: 'small' }),
}).default({});
export type ImagePipelineOptions = z.infer<typeof ImagePipelineOptionsSchema>;

export const ImagePipelineStepStatusSchema = z.enum(['ran', 'skipped']);
export type ImagePipelineStepStatus = z.infer<typeof ImagePipelineStepStatusSchema>;

export const ImagePipelineFileSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.string().optional(),
});
export type ImagePipelineFile = z.infer<typeof ImagePipelineFileSchema>;

export const ImagePipelineConvertStepSchema = z.object({
  status: ImagePipelineStepStatusSchema,
  reason: z.string().optional(),
  output: ImageConvertOutputSchema.omit({ resultUrl: true }).optional(),
});
export type ImagePipelineConvertStep = z.infer<typeof ImagePipelineConvertStepSchema>;

export const ImagePipelineCompressStepSchema = z.object({
  status: ImagePipelineStepStatusSchema,
  reason: z.string().optional(),
  output: ImageCompressOutputSchema.optional(),
});
export type ImagePipelineCompressStep = z.infer<typeof ImagePipelineCompressStepSchema>;

export const ImagePipelineOutputSchema = ImagePipelineFileSchema.extend({
  resultUrl: z.string(),
});
export type ImagePipelineOutput = z.infer<typeof ImagePipelineOutputSchema>;

export const ImagePipelineTimingsSchema = z.object({
  convertMs: z.number().nonnegative().optional(),
  compressMs: z.number().nonnegative().optional(),
  ocrPreprocessMs: z.number().nonnegative().optional(),
  ocrMs: z.number().nonnegative().optional(),
  totalMs: z.number().nonnegative().optional(),
}).catchall(z.number().nonnegative());
export type ImagePipelineTimings = z.infer<typeof ImagePipelineTimingsSchema>;

export const ImagePipelineResultSchema = z.object({
  jobId: z.string().optional(),
  status: JobStatusSchema.default('ready'),
  tool: z.literal('image.pipeline'),
  converted: ImagePipelineConvertStepSchema,
  compressed: ImagePipelineCompressStepSchema,
  output: ImagePipelineOutputSchema,
  ocr: OcrResultSchema,
  timingsMs: ImagePipelineTimingsSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ImagePipelineResult = z.infer<typeof ImagePipelineResultSchema>;
