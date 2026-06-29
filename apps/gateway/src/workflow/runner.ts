import { ImageCompressOptionsSchema, ImageConvertOptionsSchema, ImagePipelineOptionsSchema, MAX_PDF_PAGES, PDF_BATCH_SIZE, type ImagePipelineTimings } from '@aleph-tools/shared';
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
import { compressImage, convertImage, extractPdfTextBatchFromObject, getPdfInfoFromObject, ocrImage, ocrPdfBatchFromObject, type PdfInfo } from '../ocr-client';
import { maxJobAttempts } from '../config';
import { deliverDueWebhooks } from '../webhooks';
import type { Env, StorageEnv, WorkflowStepLike } from '../types';
import { buildPdfResult, normalizePageResult, ocrModeForJob, pdfExtractionModeForJob, withRequestedOcrModeMetadata } from './ocr-result';
import {
  assertValidPipelineInput,
  pipelineOcrEngineOptions,
  pipelineOcrInputFile,
  pipelineOcrInputMetadata,
  pipelineOutputFromCompress,
  pipelineOutputFromConvert,
  pipelineOutputFromFile,
  planPipelineCompression,
  planPipelineConversion,
  ranConvertStep,
  skippedCompressStep,
  skippedConvertStep,
} from './image-pipeline';

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
  const pipelineStarted = Date.now();
  const timings: ImagePipelineTimings = {};
  const options = ImagePipelineOptionsSchema.parse(job.toolOptions ?? {});
  assertValidPipelineInput(file, options);
  const sourceBytes = await file.arrayBuffer();
  let workingOutput = pipelineOutputFromFile(file, sourceBytes);
  let converted = skippedConvertStep('conversion_disabled');
  let compressed = skippedCompressStep('compression_disabled');

  const conversionPlan = planPipelineConversion(file, options);
  converted = skippedConvertStep(conversionPlan.reason ?? 'conversion_skipped');
  if (conversionPlan.shouldRun) {
    job = await step.do(`image pipeline convert progress ${job.jobId}`, async () =>
      updateJobProgress(env, job, { progress: 30, stage: 'converting', currentPage: 0, totalPages: 1 }),
    );
    await assertNotCancelled(env, job);
    const conversion = await timed(timings, 'convertMs', () =>
      step.do(`pipeline convert image ${job.jobId}`, async () => convertImage(env, file, options.convert)),
    );
    converted = ranConvertStep(conversion);
    workingOutput = pipelineOutputFromConvert(conversion);
  }

  const compressionPlan = planPipelineCompression(options);
  compressed = skippedCompressStep(compressionPlan.reason ?? 'compression_skipped');
  if (compressionPlan.shouldRun) {
    const compressionInput = pipelineOcrInputFile(workingOutput);
    job = await step.do(`image pipeline compress progress ${job.jobId}`, async () =>
      updateJobProgress(env, job, { progress: 55, stage: 'compressing', currentPage: 0, totalPages: 1 }),
    );
    await assertNotCancelled(env, job);
    const compression = await timed(timings, 'compressMs', () =>
      step.do(`pipeline compress image ${job.jobId}`, async () => compressImage(env, compressionInput, options.compress)),
    );
    workingOutput = pipelineOutputFromCompress(compression);
    compressed = {
      status: 'ran',
      output: {
        filename: compression.filename,
        mimeType: compression.mimeType,
        originalSizeBytes: compression.originalSizeBytes,
        sizeBytes: compression.bytes.byteLength,
        compressionRatio: compression.originalSizeBytes > 0 ? compression.bytes.byteLength / compression.originalSizeBytes : 0,
        ...(compression.targetSizeBytes ? { targetSizeBytes: compression.targetSizeBytes } : {}),
        targetMet: compression.targetMet,
        width: compression.width,
        height: compression.height,
        format: compression.format,
        quality: compression.quality,
        resultUrl: `/v1/jobs/${job.jobId}/output`,
      },
    };
  }

  const ocrFile = pipelineOcrInputFile(workingOutput);
  const ocrInput = pipelineOcrInputMetadata(workingOutput);
  await assertNotCancelled(env, job);
  job = await step.do(`image pipeline ocr progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 80, stage: 'ocr', currentPage: 0, totalPages: 1 }),
  );
  await assertNotCancelled(env, job);
  const ocr = await timed(timings, 'ocrMs', () =>
    step.do(`pipeline ocr image ${job.jobId}`, async () =>
      withRequestedOcrModeMetadata(await ocrImage(env, ocrFile, options.ocr.ocrMode, pipelineOcrEngineOptions(options)), options.ocr.ocrMode),
    ),
  );
  timings.ocrPreprocessMs = numericTiming(ocr.timingsMs?.preprocess);
  timings.ocrMs = numericTiming(ocr.timingsMs?.ocr) ?? timings.ocrMs;
  timings.totalMs = Date.now() - pipelineStarted;

  job = await step.do(`store image pipeline progress ${job.jobId}`, async () =>
    updateJobProgress(env, job, { progress: 95, stage: 'storing_result', currentPage: 0, totalPages: 1 }),
  );
  await step.do(`ready image pipeline ${job.jobId}`, async () =>
    setImagePipelineResult(
      env,
      job,
      converted,
      compressed,
      { ...ocrInput, bytes: workingOutput.bytes },
      ocr,
      timings,
    ),
  );
  await deliverDueWebhooks(env);
}

async function timed<T>(timings: ImagePipelineTimings, key: keyof ImagePipelineTimings, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = Date.now() - started;
  }
}

function numericTiming(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function processPdfJob(env: StorageEnv, step: WorkflowStepLike, job: StoredJob) {
  const ocrMode = ocrModeForJob(job);
  const pdfExtractionMode = pdfExtractionModeForJob(job);
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
      const textPages = claimedPages.filter((pageIndex) => shouldExtractPdfText(info, pageIndex, pdfExtractionMode));
      const ocrPages = claimedPages.filter((pageIndex) => !textPages.includes(pageIndex));
      if (pdfExtractionMode === 'text' && ocrPages.length > 0) {
        throw new Error(`PDF text extraction requested but page ${ocrPages[0]! + 1} has no usable text layer`);
      }

      for (const span of contiguousSpans(textPages)) {
        const textSource = await step.do(`load pdf text source ${job.jobId} ${span.start}`, async () => getSourceFile(env, job));
        if (!textSource) throw new Error('Source file is missing');
        const textResult = await step.do(`extract pdf text ${job.jobId} ${span.start}-${span.end}`, async () =>
          extractPdfTextBatchFromObject(env, textSource, job.document.filename, span.start, span.count),
        );
        const pagesByIndex = new Map(textResult.pages.map((page) => [page.pageIndex, page]));
        for (const pageIndex of span.pages) {
          const batchPage = pagesByIndex.get(pageIndex);
          if (!batchPage) throw new Error(`PDF text extractor returned no result for page ${pageIndex + 1}`);
          const page = normalizePageResult({ ...textResult, pages: [batchPage] }, pageIndex);
          job = await step.do(`store page ${job.jobId} ${pageIndex}`, async () => setJobPageResult(env, job, page));
        }
      }

      for (const span of contiguousSpans(ocrPages)) {
        const batchSource = await step.do(`load pdf batch source ${job.jobId} ${span.start}`, async () => getSourceFile(env, job));
        if (!batchSource) throw new Error('Source file is missing');
        const batchResult = await step.do(`ocr pdf batch ${job.jobId} ${span.start}-${span.end}`, async () =>
          ocrPdfBatchFromObject(env, batchSource, job.document.filename, span.start, span.count, ocrMode),
        );
        const pagesByIndex = new Map(batchResult.pages.map((page) => [page.pageIndex, page]));
        for (const pageIndex of span.pages) {
          const batchPage = pagesByIndex.get(pageIndex);
          if (!batchPage) throw new Error(`OCR engine returned no result for page ${pageIndex + 1}`);
          const page = normalizePageResult({ ...batchResult, pages: [batchPage] }, pageIndex);
          job = await step.do(`store page ${job.jobId} ${pageIndex}`, async () => setJobPageResult(env, job, page));
        }
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

function shouldExtractPdfText(info: PdfInfo, pageIndex: number, mode: 'auto' | 'text' | 'ocr'): boolean {
  if (mode === 'ocr') return false;
  const page = info.pages.find((entry) => entry.pageIndex === pageIndex);
  return page?.hasTextLayer === true;
}

function contiguousSpans(pageIndexes: number[]): Array<{ start: number; end: number; count: number; pages: number[] }> {
  const sorted = [...pageIndexes].sort((a, b) => a - b);
  const spans: Array<{ start: number; end: number; count: number; pages: number[] }> = [];
  for (const pageIndex of sorted) {
    const last = spans.at(-1);
    if (!last || pageIndex !== last.end + 1) {
      spans.push({ start: pageIndex, end: pageIndex, count: 1, pages: [pageIndex] });
    } else {
      last.end = pageIndex;
      last.count += 1;
      last.pages.push(pageIndex);
    }
  }
  return spans;
}

async function assertNotCancelled(env: StorageEnv, job: StoredJob) {
  const latest = await getJob(env, job.clientId, job.jobId);
  if (latest && isCancelRequested(latest)) {
    await completeCancelledJob(env, latest);
    throw new Error('Job was cancelled');
  }
}
