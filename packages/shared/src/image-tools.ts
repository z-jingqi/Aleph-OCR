import { z } from 'zod';
import { JobStatusSchema } from './jobs';

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

export const ImageCompressOptionsSchema = z.object({
  targetSizeBytes: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  minQuality: z.number().int().min(1).max(100).default(45),
  maxQuality: z.number().int().min(1).max(100).default(85),
  outputFormat: ImageCompressFormatSchema.default('jpeg'),
}).refine((value) => value.minQuality <= value.maxQuality, {
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
