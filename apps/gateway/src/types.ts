import type { Context } from 'hono';
import type { AuthEnv, AuthVariables } from './auth';
import type { ToolsClientEnv } from './ocr-client';
import type { ToolsEngineContainer } from './container';

export interface Env extends AuthEnv, ToolsClientEnv {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  TOOLS_JOBS?: Queue<QueueMessage>;
  TOOLS_ENGINE?: DurableObjectNamespace<ToolsEngineContainer>;
  TOOLS_WORKFLOW?: Workflow<ToolWorkflowParams>;
  JOB_RETENTION_DAYS?: string;
  WEBHOOK_SIGNING_SECRET?: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_ACTIVE_JOBS_PER_CLIENT?: string;
}

export type StorageEnv = Env & { DB: D1Database; ASSETS: R2Bucket };
export type QueueMessage = { jobId: string };
export type ToolWorkflowParams = { jobId: string };
export type WorkflowStepLike = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
};
export type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;
