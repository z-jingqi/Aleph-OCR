import type {
  ImagePipelineCompressStep,
  ImagePipelineConvertStep,
  ImagePipelineFile,
  ImagePipelineOptions,
  OcrMode,
} from '@aleph-tools/shared';
import { fileInfo, shouldConvertForOcr, validatePipelineImageInput } from '../http/file-types';
import type { ImageCompressResponse, ImageConvertResponse, OcrImageOptions } from '../ocr-client';

export type PipelineConvertPlan = {
  shouldRun: boolean;
  reason?: string;
};

export type PipelineCompressPlan = {
  shouldRun: boolean;
  reason?: string;
};

export type PipelineOutputCandidate = {
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  format?: string;
};

const PIPELINE_OCR_MAX_SIDE_BY_MODE: Record<OcrMode, number> = {
  tiny: 1200,
  small: 1400,
  medium: 2000,
};

export function assertValidPipelineInput(file: File, options: ImagePipelineOptions) {
  const error = validatePipelineImageInput(file, options);
  if (error) throw new Error(error);
}

export function planPipelineConversion(file: File, options: ImagePipelineOptions): PipelineConvertPlan {
  if (!options.convert.enabled) return { shouldRun: false, reason: 'conversion_disabled' };
  if (!shouldConvertForOcr(file, options)) return { shouldRun: false, reason: 'input_format_supported_by_ocr' };
  return { shouldRun: true };
}

export function planPipelineCompression(options: ImagePipelineOptions): PipelineCompressPlan {
  if (!options.compress.enabled) return { shouldRun: false, reason: 'compression_disabled' };
  return { shouldRun: true };
}

export function skippedConvertStep(reason: string): ImagePipelineConvertStep {
  return { status: 'skipped', reason };
}

export function ranConvertStep(output: ImageConvertResponse): ImagePipelineConvertStep {
  return {
    status: 'ran',
    output: {
      filename: output.filename,
      mimeType: output.mimeType,
      sizeBytes: output.bytes.byteLength,
      width: output.width,
      height: output.height,
      format: output.format,
    },
  };
}

export function skippedCompressStep(reason: string): ImagePipelineCompressStep {
  return { status: 'skipped', reason };
}

export function compressionOutputMetadata(output: ImageCompressResponse, resultUrl: string) {
  const sizeBytes = output.bytes.byteLength;
  return {
    filename: output.filename,
    mimeType: output.mimeType,
    originalSizeBytes: output.originalSizeBytes,
    sizeBytes,
    compressionRatio: output.originalSizeBytes > 0 ? sizeBytes / output.originalSizeBytes : 0,
    ...(output.targetSizeBytes ? { targetSizeBytes: output.targetSizeBytes } : {}),
    targetMet: output.targetMet,
    width: output.width,
    height: output.height,
    format: output.format,
    quality: output.quality,
    resultUrl,
  };
}

export function pipelineOutputFromFile(file: File, bytes: ArrayBuffer): PipelineOutputCandidate {
  return {
    ...fileInfo(file),
    bytes,
    sizeBytes: bytes.byteLength,
  };
}

export function pipelineOutputFromConvert(output: ImageConvertResponse): PipelineOutputCandidate {
  return {
    bytes: output.bytes,
    filename: output.filename,
    mimeType: output.mimeType,
    sizeBytes: output.bytes.byteLength,
    width: output.width,
    height: output.height,
    format: output.format,
  };
}

export function pipelineOutputFromCompress(output: ImageCompressResponse): PipelineOutputCandidate {
  return {
    bytes: output.bytes,
    filename: output.filename,
    mimeType: output.mimeType,
    sizeBytes: output.bytes.byteLength,
    width: output.width,
    height: output.height,
    format: output.format,
  };
}

export function pipelineOcrInputFile(output: PipelineOutputCandidate): File {
  return new File([output.bytes], output.filename, { type: output.mimeType });
}

export function pipelineOcrInputMetadata(output: PipelineOutputCandidate): ImagePipelineFile {
  const { bytes: _bytes, ...metadata } = output;
  return metadata;
}

export function pipelineOcrEngineOptions(options: ImagePipelineOptions): OcrImageOptions {
  return {
    maxSide: PIPELINE_OCR_MAX_SIDE_BY_MODE[options.ocr.ocrMode],
    documentCrop: true,
  };
}
