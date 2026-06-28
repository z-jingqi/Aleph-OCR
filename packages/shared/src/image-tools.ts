import { z } from 'zod';
import { JobStatusSchema } from './jobs';

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
