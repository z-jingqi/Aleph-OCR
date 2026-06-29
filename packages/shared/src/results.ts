import { z } from 'zod';
import { ImageCompressResultSchema, ImageConvertResultSchema, ImagePipelineResultSchema } from './image-tools';
import { OcrResultSchema } from './ocr';

export const ToolResultSchema = z.union([OcrResultSchema, ImageConvertResultSchema, ImageCompressResultSchema, ImagePipelineResultSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
