import { z } from 'zod';
import { JobStatusSchema } from './jobs';

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'STORAGE_UNAVAILABLE',
  'WORKFLOW_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNSUPPORTED_FORMAT',
  'FILE_TOO_LARGE',
  'JOB_NOT_FOUND',
  'JOB_NOT_READY',
  'JOB_FAILED',
  'JOB_CANCELLED',
  'JOB_DELETED',
  'RESULT_NOT_FOUND',
  'CANCEL_NOT_ALLOWED',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  httpStatus: z.number().int(),
  requestId: z.string(),
  jobId: z.string().optional(),
  jobStatus: JobStatusSchema.optional(),
  stage: z.string().optional(),
  retryable: z.boolean(),
  terminal: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
