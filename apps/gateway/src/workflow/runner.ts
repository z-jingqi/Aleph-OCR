import { ImageCompressOptionsSchema, ImageConvertOptionsSchema, ImagePipelineOptionsSchema, MAX_PDF_PAGES, PDF_BATCH_SIZE } from '@aleph-tools/shared';
import {
  claimJobForProcessing,
  claimJobPage,
  completeCancelledJob,
  failJob,
  failJobPage,
  getJob,
  getPageResults,
  getSourceFile,
  initializeJobPages,
  isCancelRequested,
  requeueJobForRetry,
  requireStorage,
  setImageConvertResult,
  setImageCompressResult,
  setImagePipelineResult,
  setJobPageResult,
  setJobResult,
  updateJobProgress,
  type StoredJob,
} from '../job-store';
import { compressImage, convertImage, getPdfInfoFromObject, ocrImage, ocrPdfBatchFromObject } from '../ocr-client';
import { maxJobAttempts } from '../config';
import { deliverDueWebhooks } from '../webhooks';
import type { Env, StorageEnv, WorkflowStepLike } from '../types';
import { buildPdfResult, normalizePageResult, ocrModeForJob, withRequestedOcrModeMetadata } from './ocr-result';

export async function processJob(env: Env, jobId: string) {
  requireStorage(env);
  await runToolWorkflow(env, jobId, createInlineWorkflowStep());
}

export async function runToolWorkflow(env: StorageEnv, jobId: string, step: WorkflowStepLike) {
  let job = await step.do(`claim ${jobId}`, async () => claimJobForProcessing(env, jobId));
  if (!job) return;
  try {
    await assertNotCancelled(env, job);
    const claimedJob = job;
    job = await step.do(`read source ${claimedJob.jobId}`, async () => updateJobProgress(env, claimedJob, { progress: 15, stage: 'reading_source' }));

    if (job.document.type === 'pdf' && job.tool !== 'image.convert') {
      await processPdfJob(env, step, job);
    } else {
      const sourceJob = job;
      const object = await step.do(`load source ${sourceJob.jobId}`, async () => getSourceFile(env, sourceJob));
      if (!object) throw new Error('Source file is missing');
      const bytes = await object.arrayBuffer();
      const file = new File([bytes], job.document.filename, { type: job.document.mimeType });
      if (job.tool === 'image.convert') {
        await processImageConvertJob(env, step, job, file);
      } else if (job.tool === 'image.compress') {
        await processImageCompressJob(env, step, job, file);
      } else if (job.tool === 'image.pipeline') {
        await processImagePipelineJob(env, step, job, file);
      } else {
        await processImageJob(env, step, job, file);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown tools job error';
    const latest = (await getJob(env, job.clientId, job.jobId)) ?? job;
    let cancelled = false;
    const shouldRetry = job.attemptCount < maxJobAttempts(env);
    if (isCancelRequested(latest)) {
      await completeCancelledJob(env, latest);
      cancelled = true;
    } else if (shouldRetry) {
      await requeueJobForRetry(env, latest, message);
    } else {
      await failJob(env, latest, message);
    }
    await deliverDueWebhooks(env);
    if (!cancelled && shouldRetry) throw error;
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

export async function startQueuedToolJob(env: Env, jobId: string) {
  if (!env.TOOLS_JOBS) throw new Error('Tools queue is not configured');
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

async function processImageJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  const ocrMode = ocrModeForJob(job);
  job = await step.do(`image progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 50, stage: 'ocr', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const result = await step.do(`ocr image ${job.jobId}`, async () => withRequestedOcrModeMetadata(await ocrImage(env, file, ocrMode), ocrMode));
  await assertNotCancelled(env, job);
  job = await step.do(`store image result ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 90, stage: 'storing_result' }));
  await step.do(`ready image ${job.jobId}`, async () => setJobResult(env, job, result));
  await deliverDueWebhooks(env);
}

async function processImageConvertJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  const options = ImageConvertOptionsSchema.parse(job.toolOptions ?? {});
  job = await step.do(`image convert progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 50, stage: 'processing', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const output = await step.do(`convert image ${job.jobId}`, async () => convertImage(env, file, options));
  await assertNotCancelled(env, job);
  job = await step.do(`store image conversion progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 90, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
  );
  await step.do(`ready image conversion ${job.jobId}`, async () => setImageConvertResult(env, job, output));
  await deliverDueWebhooks(env);
}

async function processImageCompressJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  const options = ImageCompressOptionsSchema.parse(job.toolOptions ?? {});
  job = await step.do(`image compress progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 50, stage: 'processing', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const output = await step.do(`compress image ${job.jobId}`, async () => compressImage(env, file, options));
  await assertNotCancelled(env, job);
  job = await step.do(`store image compression progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 90, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
  );
  await step.do(`ready image compression ${job.jobId}`, async () => setImageCompressResult(env, job, output));
  await deliverDueWebhooks(env);
}

async function processImagePipelineJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob, file: File) {
  const options = ImagePipelineOptionsSchema.parse(job.toolOptions ?? {});
  job = await step.do(`image pipeline convert progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 30, stage: 'converting', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const converted = await step.do(`pipeline convert image ${job.jobId}`, async () => convertImage(env, file, options.convert));

  const convertedFile = new File([converted.bytes], converted.filename, { type: converted.mimeType });
  job = await step.do(`image pipeline compress progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 55, stage: 'compressing', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const compressed = await step.do(`pipeline compress image ${job.jobId}`, async () => compressImage(env, convertedFile, options.compress));

  const compressedFile = new File([compressed.bytes], compressed.filename, { type: compressed.mimeType });
  job = await step.do(`image pipeline ocr progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 80, stage: 'ocr', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const ocr = await step.do(`pipeline ocr image ${job.jobId}`, async () =>
    withRequestedOcrModeMetadata(await ocrImage(env, compressedFile, options.ocr.ocrMode), options.ocr.ocrMode),
  );

  job = await step.do(`store image pipeline progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 95, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
  );
  await step.do(`ready image pipeline ${job.jobId}`, async () =>
    setImagePipelineResult(
      env,
      job,
      {
        filename: converted.filename,
        mimeType: converted.mimeType,
        sizeBytes: converted.bytes.byteLength,
        width: converted.width,
        height: converted.height,
        format: converted.format,
      },
      compressed,
      ocr,
    ),
  );
  await deliverDueWebhooks(env);
}

async function processPdfJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob) {
  const ocrMode = ocrModeForJob(job);
  job = await step.do(`plan pdf ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 20, stage: 'planning_pages' }));
  const infoSource = await step.do(`load pdf info source ${job.jobId}`, async () => getSourceFile(env, job));
  if (!infoSource) throw new Error('Source file is missing');
  const info = await step.do(`pdf info ${job.jobId}`, async () => getPdfInfoFromObject(env, infoSource, job.document.filename));
  if (info.pageCount > MAX_PDF_PAGES) throw new Error(`PDF has ${info.pageCount} pages; max supported pages is ${MAX_PDF_PAGES}`);
  await step.do(`init pages ${job.jobId}`, async () => initializeJobPages(env, job, info.pageCount));
  job = await step.do(`pdf planned ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 25, stage: 'ocr', currentPage: 0, totalPages: info.pageCount }),
  );

  for (let batchStart = 0; batchStart < info.pageCount; batchStart += PDF_BATCH_SIZE) {
    await assertNotCancelled(env, job);
    const batchPageCount = Math.min(PDF_BATCH_SIZE, info.pageCount - batchStart);
    const batchEnd = batchStart + batchPageCount;
    const claimedPages: number[] = [];
    for (let pageIndex = batchStart; pageIndex < batchEnd; pageIndex += 1) {
      const claimed = await step.do(`claim page ${job.jobId} ${pageIndex}`, async () => claimJobPage(env, job, pageIndex));
      if (claimed) claimedPages.push(pageIndex);
    }
    if (claimedPages.length === 0) continue;
    try {
      const batchSource = await step.do(`load pdf batch source ${job.jobId} ${batchStart}`, async () => getSourceFile(env, job));
      if (!batchSource) throw new Error('Source file is missing');
      const batchResult = await step.do(`ocr pdf batch ${job.jobId} ${batchStart}-${batchEnd - 1}`, async () =>
        ocrPdfBatchFromObject(env, batchSource, job.document.filename, batchStart, batchPageCount, ocrMode),
      );
      const pagesByIndex = new Map(batchResult.pages.map((page) => [page.pageIndex, page]));
      for (const pageIndex of claimedPages) {
        const batchPage = pagesByIndex.get(pageIndex);
        if (!batchPage) throw new Error(`OCR engine returned no result for page ${pageIndex + 1}`);
        const page = normalizePageResult({ ...batchResult, pages: [batchPage] }, pageIndex);
        job = await step.do(`store page ${job.jobId} ${pageIndex}`, async () => setJobPageResult(env, job, page));
      }
    } catch (error) {
      await Promise.all(claimedPages.map((pageIndex) => failJobPage(env, job, pageIndex, error instanceof Error ? error.message : 'Page OCR failed')));
      throw error;
    }
  }

  await assertNotCancelled(env, job);
  job = await step.do(`merge pdf progress ${job.jobId}`, async () => updateJobProgress(env, job, { progress: 95, stage: 'storing_result' }));
  const pages = await step.do(`read page results ${job.jobId}`, async () => getPageResults(env, job));
  const result = buildPdfResult(job, pages);
  await step.do(`ready pdf ${job.jobId}`, async () => setJobResult(env, job, result));
  await deliverDueWebhooks(env);
}

async function assertNotCancelled(env: StorageEnv, job: StoredJob) {
  const latest = await getJob(env, job.clientId, job.jobId);
  if (latest && isCancelRequested(latest)) {
    await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled');
  }
}
