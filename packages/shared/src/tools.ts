import { z } from 'zod';

export const ToolTypeSchema = z.literal('ocr');
export type ToolType = z.infer<typeof ToolTypeSchema>;
