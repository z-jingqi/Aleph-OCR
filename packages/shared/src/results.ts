import { z } from 'zod';
import { ImageCompressResultSchema, ImageConvertResultSchema } from './image-tools';
import { OcrResultSchema } from './ocr';

export const ToolResultSchema = z.union([OcrResultSchema, ImageConvertResultSchema, ImageCompressResultSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
