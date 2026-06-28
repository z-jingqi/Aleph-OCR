import { z } from 'zod';
import { ImageConvertFormatSchema } from './image-tools';
import { OcrModeSchema, OcrModeValues } from './ocr';

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
