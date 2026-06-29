import { Hono } from 'hono';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { requireApiKey, type AuthVariables } from './auth';
import { ToolsEngineContainer } from './container';
import { requestIdMiddleware } from './http/request-id';
import { requireStorage } from './job-store';
import { runScheduledMaintenance } from './maintenance';
import { registerImageCompressRoutes } from './routes/image-compress';
import { registerImageConvertRoutes } from './routes/image-convert';
import { registerImagePipelineRoutes } from './routes/image-pipeline';
import { registerJobRoutes } from './routes/jobs';
import { registerOcrRoutes } from './routes/ocr';
import { registerSystemRoutes } from './routes/system';
import type { Env, QueueMessage, ToolWorkflowParams, WorkflowStepLike } from './types';
import { processJob, runToolWorkflow } from './workflow/runner';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', requestIdMiddleware);
registerSystemRoutes(app);
app.use('/v1/*', requireApiKey());
registerOcrRoutes(app);
registerImageConvertRoutes(app);
registerImageCompressRoutes(app);
registerImagePipelineRoutes(app);
registerJobRoutes(app);

export { ToolsEngineContainer };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (!message.body?.jobId) throw new Error('Invalid tools queue message');
        await processJob(env, message.body.jobId);
        message.ack();
      } catch (error) {
        console.error('Tools job failed', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;

export class ToolJobWorkflow extends WorkflowEntrypoint<Env, ToolWorkflowParams> {
  async run(event: Readonly<{ payload: ToolWorkflowParams }>, step: WorkflowStepLike) {
    requireStorage(this.env);
    await runToolWorkflow(this.env, event.payload.jobId, step);
  }
}

export { processJob, runToolWorkflow };
