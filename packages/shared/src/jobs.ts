import { z } from 'zod';
import { OcrDocumentSchema } from './documents';
import { ToolTypeSchema } from './tools';

export const JobStatusSchema = z.enum(['queued', 'processing', 'cancel_requested', 'cancelled', 'ready', 'failed', 'deleted']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobStageSchema = z.enum([
  'queued',
  'processing',
  'reading_source',
  'planning_pages',
  'converting',
  'compressing',
  'ocr',
  'storing_page',
  'storing_result',
  'cancel_requested',
  'cancelled',
  'ready',
  'failed',
  'deleted',
]);
export type JobStage = z.infer<typeof JobStageSchema>;

export const OcrJobPageStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed', 'cancelled']);
export type OcrJobPageStatus = z.infer<typeof OcrJobPageStatusSchema>;

export const OcrJobSchema = z.object({
  jobId: z.string(),
  tool: ToolTypeSchema.optional(),
  operation: z.string().optional(),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100).default(0),
  stage: JobStageSchema.optional(),
  currentPage: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  document: OcrDocumentSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  terminal: z.boolean().optional(),
  cancelable: z.boolean().optional(),
  retryable: z.boolean().optional(),
  resultAvailable: z.boolean().optional(),
  outputAvailable: z.boolean().optional(),
});
export type OcrJob = z.infer<typeof OcrJobSchema>;

export const OcrJobEventTypeSchema = z.enum([
  'job.created',
  'job.status',
  'job.progress',
  'job.page.ready',
  'job.ready',
  'job.failed',
  'job.cancel_requested',
  'job.cancelled',
  'job.deleted',
]);
export type OcrJobEventType = z.infer<typeof OcrJobEventTypeSchema>;

export const OcrJobEventSchema = z.object({
  eventId: z.string(),
  jobId: z.string(),
  sequence: z.number().int().positive(),
  type: OcrJobEventTypeSchema,
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type OcrJobEvent = z.infer<typeof OcrJobEventSchema>;
