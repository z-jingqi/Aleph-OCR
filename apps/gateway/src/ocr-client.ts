import {
  EngineInfoSchema,
  type ImageCompressFormat,
  type ImageCompressOptions,
  OcrResultSchema,
  type EngineInfo,
  type ImageConvertFormat,
  type ImageConvertOptions,
  type OcrMode,
  type OcrResult,
} from '@aleph-tools/shared';

export interface ToolsClientEnv {
  ALEPH_TOOLS_ENGINE_URL?: string;
  TOOLS_ENGINE_TOKEN?: string;
  TOOLS_ENGINE?: {
    getByName(name: string): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

export type OcrClientEnv = ToolsClientEnv;

export type ImageConvertResponse = {
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  format: ImageConvertFormat;
};

export type ImageCompressResponse = {
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
  originalSizeBytes: number;
  width: number;
  height: number;
  format: ImageCompressFormat;
  quality: number;
  targetSizeBytes?: number;
  targetMet: boolean;
};

export type PdfSourceObject = {
  body: ReadableStream;
};

export class OcrEngineError extends Error {
  constructor(message: string, public status = 503) {
    super(message);
    this.name = 'OcrEngineError';
  }
}

export async function getEngineInfo(env: ToolsClientEnv): Promise<EngineInfo> {
  const response = await engineFetch(env, '/health', { method: 'GET' });
  const data = await response.json();
  return EngineInfoSchema.parse(data);
}

export async function ocrImage(env: ToolsClientEnv, file: File, mode: OcrMode = 'small'): Promise<OcrResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await engineFetch(env, ocrPath('/internal/ocr/image', mode), { method: 'POST', body: form });
  const data = await response.json();
  return OcrResultSchema.parse(data);
}

export async function getPdfInfoFromObject(env: ToolsClientEnv, object: PdfSourceObject, filename: string): Promise<{ pageCount: number }> {
  const response = await engineFetch(env, pdfRawPath('/internal/ocr/pdf-info', { filename }), {
    method: 'POST',
    body: object.body,
    duplex: 'half',
    headers: { 'Content-Type': 'application/pdf' },
  } as RequestInit & { duplex: 'half' });
  const data = (await response.json()) as { pageCount?: unknown };
  if (!Number.isInteger(data.pageCount) || Number(data.pageCount) < 0) {
    throw new OcrEngineError('OCR engine returned invalid PDF metadata', 500);
  }
  return { pageCount: Number(data.pageCount) };
}

export async function ocrPdfBatchFromObject(
  env: ToolsClientEnv,
  object: PdfSourceObject,
  filename: string,
  startPage: number,
  pageCount: number,
  mode: OcrMode = 'small',
): Promise<OcrResult> {
  const response = await engineFetch(env, ocrPath('/internal/ocr/pdf-batch', mode, { filename, start_page: startPage, page_count: pageCount }), {
    method: 'POST',
    body: object.body,
    duplex: 'half',
    headers: { 'Content-Type': 'application/pdf' },
  } as RequestInit & { duplex: 'half' });
  const data = await response.json();
  return OcrResultSchema.parse(data);
}

export async function convertImage(env: ToolsClientEnv, file: File, options: ImageConvertOptions): Promise<ImageConvertResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('target_format', options.targetFormat);
  form.append('fit', options.fit ?? 'inside');
  if (options.quality !== undefined) form.append('quality', String(options.quality));
  if (options.width !== undefined) form.append('width', String(options.width));
  if (options.height !== undefined) form.append('height', String(options.height));

  const response = await engineFetch(env, '/internal/image/convert', { method: 'POST', body: form });
  const bytes = await response.arrayBuffer();
  const filename = response.headers.get('X-Aleph-Tools-Filename') ?? convertedFilename(file.name, options.targetFormat);
  const mimeType = response.headers.get('Content-Type')?.split(';')[0] ?? mimeTypeForFormat(options.targetFormat);
  const width = Number(response.headers.get('X-Aleph-Tools-Width'));
  const height = Number(response.headers.get('X-Aleph-Tools-Height'));
  const format = response.headers.get('X-Aleph-Tools-Format') ?? options.targetFormat;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !isImageConvertFormat(format)) {
    throw new OcrEngineError('Image conversion engine returned invalid metadata', 500);
  }
  return { bytes, filename, mimeType, width, height, format };
}

export async function compressImage(env: ToolsClientEnv, file: File, options: ImageCompressOptions): Promise<ImageCompressResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('output_format', options.outputFormat ?? 'jpeg');
  form.append('min_quality', String(options.minQuality ?? 45));
  form.append('max_quality', String(options.maxQuality ?? 85));
  if (options.targetSizeBytes !== undefined) form.append('target_size_bytes', String(options.targetSizeBytes));
  if (options.maxWidth !== undefined) form.append('max_width', String(options.maxWidth));
  if (options.maxHeight !== undefined) form.append('max_height', String(options.maxHeight));

  const response = await engineFetch(env, '/internal/image/compress', { method: 'POST', body: form });
  const bytes = await response.arrayBuffer();
  const filename = response.headers.get('X-Aleph-Tools-Filename') ?? compressedFilename(file.name, options.outputFormat ?? 'jpeg');
  const mimeType = response.headers.get('Content-Type')?.split(';')[0] ?? mimeTypeForFormat(options.outputFormat ?? 'jpeg');
  const width = Number(response.headers.get('X-Aleph-Tools-Width'));
  const height = Number(response.headers.get('X-Aleph-Tools-Height'));
  const originalSizeBytes = Number(response.headers.get('X-Aleph-Tools-Original-Size-Bytes'));
  const quality = Number(response.headers.get('X-Aleph-Tools-Quality'));
  const format = response.headers.get('X-Aleph-Tools-Format') ?? options.outputFormat ?? 'jpeg';
  const targetSizeHeader = response.headers.get('X-Aleph-Tools-Target-Size-Bytes');
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isInteger(originalSizeBytes) ||
    originalSizeBytes < 0 ||
    !Number.isInteger(quality) ||
    quality < 1 ||
    quality > 100 ||
    !isImageCompressFormat(format)
  ) {
    throw new OcrEngineError('Image compression engine returned invalid metadata', 500);
  }
  return {
    bytes,
    filename,
    mimeType,
    originalSizeBytes,
    width,
    height,
    format,
    quality,
    ...(targetSizeHeader ? { targetSizeBytes: Number(targetSizeHeader) } : {}),
    targetMet: response.headers.get('X-Aleph-Tools-Target-Met') === 'true',
  };
}

async function engineFetch(env: ToolsClientEnv, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = env.TOOLS_ENGINE_TOKEN;
  if (token) {
    headers.set('X-Aleph-Tools-Internal-Token', token);
  }

  let response: Response;
  try {
    if (env.TOOLS_ENGINE) {
      const request = new Request(new URL(path, 'http://tools-engine.internal'), { ...init, headers });
      response = await env.TOOLS_ENGINE.getByName('shared').fetch(request);
    } else {
      const baseUrl = env.ALEPH_TOOLS_ENGINE_URL || 'http://127.0.0.1:8090';
      response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    }
  } catch (error) {
    throw new OcrEngineError(`OCR engine is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OcrEngineError(text || `OCR engine returned ${response.status}`, response.status);
  }
  return response;
}

function convertedFilename(filename: string, format: ImageConvertFormat): string {
  const extension = format === 'jpeg' ? 'jpg' : format;
  const base = filename.replace(/\.[^.]+$/, '') || 'image';
  return `${base}.${extension}`;
}

function compressedFilename(filename: string, format: ImageCompressFormat): string {
  const extension = format === 'jpeg' ? 'jpg' : format;
  const base = filename.replace(/\.[^.]+$/, '') || 'image';
  return `${base}.compressed.${extension}`;
}

function mimeTypeForFormat(format: ImageConvertFormat | ImageCompressFormat): string {
  return `image/${format === 'jpeg' ? 'jpeg' : format}`;
}

function isImageConvertFormat(value: string): value is ImageConvertFormat {
  return ['png', 'jpeg', 'webp', 'avif'].includes(value);
}

function isImageCompressFormat(value: string): value is ImageCompressFormat {
  return ['jpeg', 'webp'].includes(value);
}

function ocrPath(path: string, mode: OcrMode, params: Record<string, string | number> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  search.set('mode', mode);
  return `${path}?${search.toString()}`;
}

function pdfRawPath(path: string, params: Record<string, string | number> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}
