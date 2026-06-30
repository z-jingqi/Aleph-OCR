import { z } from 'zod';
import { OcrResultSchema } from './ocr';

export const ToolResultSchema = OcrResultSchema;
export type ToolResult = z.infer<typeof ToolResultSchema>;
