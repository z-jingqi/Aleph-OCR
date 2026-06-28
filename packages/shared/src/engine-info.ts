import { z } from 'zod';
import { ImageCompressFormatSchema, ImageConvertFormatSchema } from './image-tools';
import { OcrModeSchema, OcrModeValues } from './ocr';

export const EngineInfoSchema = z.object({
  engine: z.string(),
  engineVersion: z.string(),
  modes: z.array(OcrModeSchema).default([...OcrModeValues]),
  defaultMode: OcrModeSchema.default('small'),
  modeConfig: z.record(z.unknown()).default({}),
  capabilities: z.object({
    image: z.boolean(),
    pdf: z.boolean(),
    syncImage: z.boolean(),
    imageConvert: z.boolean().optional(),
    imageConvertFormats: z.array(ImageConvertFormatSchema).optional(),
    imageCompress: z.boolean().optional(),
    imageCompressFormats: z.array(ImageCompressFormatSchema).optional(),
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
