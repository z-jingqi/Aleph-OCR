import { z } from 'zod';

export const ToolTypeSchema = z.enum(['ocr', 'image.convert']);
export type ToolType = z.infer<typeof ToolTypeSchema>;
