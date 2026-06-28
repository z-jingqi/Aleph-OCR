import { z } from 'zod';

export const ToolTypeSchema = z.enum(['ocr', 'image.convert', 'image.compress']);
export type ToolType = z.infer<typeof ToolTypeSchema>;
