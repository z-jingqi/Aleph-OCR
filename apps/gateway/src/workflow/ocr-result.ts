import {
  PdfExtractionModeSchema,
  OcrModeSchema,
  type ExtractionMethod,
  type PdfExtractionMode,
  type OcrMode,
  type OcrPage,
  type OcrQuality,
  type OcrResult,
} from '@aleph-tools/shared';
import type { StoredJob } from '../job-store';

export function ocrModeForJob(job: StoredJob): OcrMode {
  const parsed = OcrModeSchema.safeParse(job.toolOptions?.ocrMode);
  return parsed.success ? parsed.data : 'small';
}

export function pdfExtractionModeForJob(job: StoredJob): PdfExtractionMode {
  const parsed = PdfExtractionModeSchema.safeParse(job.toolOptions?.pdfExtractionMode);
  return parsed.success ? parsed.data : 'auto';
}

export function withRequestedOcrModeMetadata(result: OcrResult, requestedOcrMode: OcrMode): OcrResult {
  const metadata = result.metadata ?? {};
  const ocrMode = metadata.ocrMode ?? result.ocrMode ?? requestedOcrMode;
  const normalizedRequestedOcrMode = metadata.requestedOcrMode ?? result.requestedOcrMode ?? requestedOcrMode;
  const fallbackUsed = metadata.fallbackUsed ?? result.fallbackUsed ?? ocrMode !== normalizedRequestedOcrMode;
  return {
    ...result,
    ocrMode: result.ocrMode ?? ocrMode,
    requestedOcrMode: result.requestedOcrMode ?? normalizedRequestedOcrMode,
    fallbackUsed,
    metadata: {
      ...metadata,
      ocrMode,
      requestedOcrMode: normalizedRequestedOcrMode,
      fallbackUsed,
      ...(metadata.quality === undefined && result.quality !== undefined ? { quality: result.quality } : {}),
      ...(metadata.timingsMs === undefined && result.timingsMs !== undefined ? { timingsMs: result.timingsMs } : {}),
    },
  };
}

export function normalizePageResult(result: OcrResult, pageIndex: number): OcrPage {
  const page = result.pages[0];
  if (!page) throw new Error(`OCR engine returned no result for page ${pageIndex + 1}`);
  return {
    ...page,
    pageIndex,
    ocrMode: page.ocrMode ?? result.ocrMode,
    requestedOcrMode: page.requestedOcrMode ?? result.requestedOcrMode,
    fallbackUsed: page.fallbackUsed ?? result.fallbackUsed,
    extractionMethod: page.extractionMethod ?? (result.extractionMethod === 'pdf_text' ? 'pdf_text' : 'ocr'),
    ...(page.quality === undefined && result.quality !== undefined ? { quality: result.quality } : {}),
    ...(page.timingsMs === undefined && result.timingsMs !== undefined ? { timingsMs: result.timingsMs } : {}),
  };
}

export function buildPdfResult(job: StoredJob, pages: OcrPage[]): OcrResult {
  const requestedOcrMode = ocrModeForJob(job);
  const pdfExtractionMode = pdfExtractionModeForJob(job);
  const extractionMethod = aggregateExtractionMethod(pages);
  const ocrPages = pages.filter((page) => (page.extractionMethod ?? 'ocr') === 'ocr');
  const fallbackUsed = ocrPages.some((page) => page.fallbackUsed || (page.ocrMode && page.ocrMode !== requestedOcrMode));
  const ocrMode: OcrMode = fallbackUsed ? 'medium' : requestedOcrMode;
  const quality = buildOcrQuality(pages);
  const timingsMs = aggregateOcrTimings(pages);
  const plainText = pages.map((page) => page.text).filter(Boolean).join('\n\n');
  const markdown = pages
    .map((page) => (page.text ? `## Page ${page.pageIndex + 1}\n\n${page.text}` : ''))
    .filter(Boolean)
    .join('\n\n');
  return {
    status: 'ready',
    engine: 'paddleocr',
    engineVersion: '3.x',
    document: job.document,
    pages,
    plainText,
    markdown,
    extractionMethod,
    ocrMode,
    requestedOcrMode,
    fallbackUsed,
    quality,
    ...(timingsMs ? { timingsMs } : {}),
    metadata: {
      ocrMode,
      requestedOcrMode,
      pdfExtractionMode,
      extractionMethod,
      fallbackUsed,
      quality,
      ...(timingsMs ? { timingsMs } : {}),
    },
  };
}

function aggregateExtractionMethod(pages: OcrPage[]): ExtractionMethod {
  const methods = new Set(pages.map((page) => page.extractionMethod ?? 'ocr'));
  if (methods.size === 1 && methods.has('pdf_text')) return 'pdf_text';
  if (methods.size === 1 && methods.has('ocr')) return 'ocr';
  return 'mixed';
}

function aggregateOcrTimings(pages: OcrPage[]) {
  const totals: Record<string, number> = {};
  let hasTimings = false;
  for (const page of pages) {
    const timings = page.timingsMs;
    if (!timings) continue;
    hasTimings = true;
    for (const [key, value] of Object.entries(timings)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  if (!hasTimings) return null;
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Math.round(value * 1000) / 1000]));
}

function buildOcrQuality(pages: OcrPage[]) {
  const text = pages.map((page) => page.text).join('');
  const effectiveTextLength = text.replace(/\s+/g, '').length;
  const blocks = pages.flatMap((page) => page.blocks);
  const confidenceValues = blocks
    .map((block) => block.confidence)
    .filter((value): value is number => typeof value === 'number');
  const averageConfidence = confidenceValues.length > 0 ? confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length : null;
  const reasons: string[] = [];
  if (blocks.length === 0) reasons.push('no_blocks');
  if (effectiveTextLength < 20) reasons.push('short_text');
  if (averageConfidence !== null && averageConfidence < 0.82) reasons.push('low_confidence');
  const fallbackReasons = [...reasons];
  let pageQualityMetadataFound = false;
  let lowQualityPageCount = 0;
  for (const page of pages) {
    const quality = qualityRecord(page.quality);
    const initialQuality = qualityRecord(quality?.initial);
    const pageFallbackReasons = [
      ...stringArray(quality?.fallbackReasons),
      ...stringArray(quality?.reasons),
      ...stringArray(initialQuality?.fallbackReasons),
      ...stringArray(initialQuality?.reasons),
    ];
    if (quality || initialQuality) pageQualityMetadataFound = true;
    appendUnique(fallbackReasons, pageFallbackReasons);
    if (quality?.lowQuality === true || initialQuality?.lowQuality === true || pageFallbackReasons.length > 0) {
      lowQualityPageCount += 1;
    }
  }
  return {
    score: averageConfidence ?? (blocks.length > 0 ? 0.75 : 0),
    lowQuality: reasons.length > 0,
    reasons,
    fallbackReasons,
    blockCount: blocks.length,
    effectiveTextLength,
    averageConfidence,
    pageCount: pages.length,
    lowQualityPageCount: pageQualityMetadataFound ? lowQualityPageCount : reasons.length > 0 ? 1 : 0,
  };
}

function qualityRecord(value: unknown): (OcrQuality & Record<string, unknown>) | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as OcrQuality & Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function appendUnique(target: string[], values: string[]) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}
