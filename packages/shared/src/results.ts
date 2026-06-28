import { z } from 'zod';
import { ImageConvertResultSchema } from './image-tools';
import { OcrResultSchema } from './ocr';

export const ToolResultSchema = z.union([OcrResultSchema, ImageConvertResultSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
