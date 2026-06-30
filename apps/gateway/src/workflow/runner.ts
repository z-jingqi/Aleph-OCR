import { maxJobAttempts } from '../config';
import {
  claimJobForProcessing,
  completeCancelledJob,
  failJob,
  getJob,
  getSourceFile,
  isCancelRequested,
  requeueJobForRetry,
  requireStorage,
  setJobResult,
  updateJobProgress,
  type StoredJob,
} from '../job-store';
import { ocrImage } from '../ocr-client';
import { prepareOcrInput } from '../ocr-input';
import { deliverDueWebhooks } from '../webhooks';
import type { Env, StorageEnv, WorkflowStepLike } from '../types';

export async function processJob(env: Env, jobId: string) {
  requireStorage(env);
  await runToolWorkflow(env, jobId, createInlineWorkflowStep());
}

export async function runToolWorkflow(env: StorageEnv, jobId: string, step: WorkflowStepLike) {
  let job = await step.do(`claim ${jobId}`, async () => claimJobForProcessing(env, jobId));
  if (!job) return;
  try {
    await assertNotCancelled(env, job);
    job = await step.do(`read source ${job.jobId}`, async () => updateJobProgress(env, job!, { progress: 20, stage: 'reading_source' }));
    const object = await step.do(`load source ${job.jobId}`, async () => getSourceFile(env, job!));
    if (!object) throw new Error('Source file is missing');

    const bytes = await object.arrayBuffer();
    const sourceFile = new File([bytes], job.document.filename, { type: job.document.mimeType });
    const input = await step.do(`prepare image ${job.jobId}`, async () => prepareOcrInput(env, sourceFile));
    if (input.converted) {
      job = await step.do(`converted ${job.jobId}`, async () => updateJobProgress(env, job!, { progress: 45, stage: 'converting' }));
    }

    await assertNotCancelled(env, job);
    job = await step.do(`ocr progress ${job.jobId}`, async () =>
      updateJobProgress(env, job!, { progress: 70, stage: 'ocr', currentPage: 0, totalPages: 1 }),
    );
    const result = await step.do(`ocr image ${job.jobId}`, async () => ocrImage(env, input.file, input));

    await assertNotCancelled(env, job);
    job = await step.do(`store result ${job.jobId}`, async () =>
      updateJobProgress(env, job!, { progress: 90, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
    );
    await step.do(`ready ${job.jobId}`, async () => setJobResult(env, job!, result));
    await deliverDueWebhooks(env);
  } catch (error) {
    await handleWorkflowError(env, job, error);
  }
}

export async function startToolWorkflow(env: Env, jobId: string, workflowId: string) {
  const workflow = env.TOOLS_WORKFLOW;
  if (workflow) {
    await workflow.create({
      id: workflowId,
      params: { jobId },
      retention: { successRetention: '7 days', errorRetention: '14 days' },
    });
    return;
  }
  if (!env.TOOLS_JOBS) throw new Error('Tools workflow is not configured');
  await env.TOOLS_JOBS.send({ jobId });
}

export function createInlineWorkflowStep(): WorkflowStepLike {
  return {
    async do<T>(_name: string, configOrCallback: Record<string, unknown> | (() => Promise<T>), maybeCallback?: () => Promise<T>): Promise<T> {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      if (!callback) throw new Error('Workflow step callback is required');
      return callback();
    },
  };
}

async function handleWorkflowError(env: StorageEnv, job: StoredJob, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown OCR job error';
  const latest = (await getJob(env, job.clientId, job.jobId)) ?? job;
  const shouldRetry = !isNonRetryableJobError(error) && job.attemptCount < maxJobAttempts(env);
  if (isCancelRequested(latest)) {
    await completeCancelledJob(env, latest);
  } else if (shouldRetry) {
    await requeueJobForRetry(env, latest, message);
    await deliverDueWebhooks(env);
    throw error;
  } else {
    await failJob(env, latest, message);
  }
  await deliverDueWebhooks(env);
}

function isNonRetryableJobError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'OcrEngineError' || error.name === 'TypeError') && 'retryable' in error && error.retryable === false;
}

async function assertNotCancelled(env: StorageEnv, job: StoredJob) {
  const latest = await getJob(env, job.clientId, job.jobId);
  if (latest && isCancelRequested(latest)) {
    await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled');
  }
}
