import type { Context } from 'hono';
import type { AuthEnv, AuthVariables } from './auth';
import type { ImageTransformEnv } from './image-transform';
import type { OcrClientEnv } from './ocr-client';

export interface Env extends AuthEnv, OcrClientEnv, ImageTransformEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  TOOLS_JOBS?: Queue<QueueMessage>;
  TOOLS_WORKFLOW?: Workflow<ToolWorkflowParams>;
  JOB_RETENTION_DAYS?: string;
  ALEPH_TOOLS_WEBHOOK_SECRETS?: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_ACTIVE_JOBS_PER_CLIENT?: string;
  MAX_ACTIVE_JOBS_GLOBAL?: string;
  MAX_IMAGE_UPLOAD_BYTES?: string;
  ENABLE_SYNC_ENDPOINTS?: string;
}

export type StorageEnv = Env & { DB: D1Database; ASSETS: R2Bucket };
export type QueueMessage = { jobId: string };
export type ToolWorkflowParams = { jobId: string };
export type WorkflowStepLike = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
};
export type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;
