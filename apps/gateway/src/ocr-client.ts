import { EngineInfoSchema, OcrResultSchema, type EngineInfo, type OcrResult } from '@aleph-ocr/shared';

export interface OcrClientEnv {
  OCR_ENGINE_URL?: string;
  OCR_ENGINE_TOKEN?: string;
}

export class OcrEngineError extends Error {
  constructor(message: string, public status = 503) {
    super(message);
    this.name = 'OcrEngineError';
  }
}

export async function getEngineInfo(env: OcrClientEnv): Promise<EngineInfo> {
  const response = await engineFetch(env, '/health', { method: 'GET' });
  const data = await response.json();
  return EngineInfoSchema.parse(data);
}

export async function ocrImage(env: OcrClientEnv, file: File): Promise<OcrResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await engineFetch(env, '/internal/ocr/image', { method: 'POST', body: form });
  const data = await response.json();
  return OcrResultSchema.parse(data);
}

export async function ocrPdf(env: OcrClientEnv, file: File): Promise<OcrResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await engineFetch(env, '/internal/ocr/pdf', { method: 'POST', body: form });
  const data = await response.json();
  return OcrResultSchema.parse(data);
}

export async function getPdfInfo(env: OcrClientEnv, file: File): Promise<{ pageCount: number }> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await engineFetch(env, '/internal/ocr/pdf-info', { method: 'POST', body: form });
  const data = (await response.json()) as { pageCount?: unknown };
  if (!Number.isInteger(data.pageCount) || Number(data.pageCount) < 0) {
    throw new OcrEngineError('OCR engine returned invalid PDF metadata', 500);
  }
  return { pageCount: Number(data.pageCount) };
}

export async function ocrPdfPage(env: OcrClientEnv, file: File, pageIndex: number): Promise<OcrResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await engineFetch(env, `/internal/ocr/pdf-page?page_index=${pageIndex}`, { method: 'POST', body: form });
  const data = await response.json();
  return OcrResultSchema.parse(data);
}

async function engineFetch(env: OcrClientEnv, path: string, init: RequestInit): Promise<Response> {
  const baseUrl = env.OCR_ENGINE_URL ?? 'http://127.0.0.1:8090';
  const headers = new Headers(init.headers);
  if (env.OCR_ENGINE_TOKEN) {
    headers.set('X-Aleph-OCR-Internal-Token', env.OCR_ENGINE_TOKEN);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    throw new OcrEngineError(`OCR engine is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OcrEngineError(text || `OCR engine returned ${response.status}`, response.status);
  }
  return response;
}
