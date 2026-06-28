import {
  ImageConvertOptionsSchema,
  OcrModeSchema,
  type ImageConvertOptions,
  type OcrMode,
} from '@aleph-tools/shared';

export type UploadParseError = { ok: false; status: 400 | 413 | 415; error: string };

export async function readUploadedFile(request: Request): Promise<
  | { ok: true; file: File; ocrMode: OcrMode; callbackUrl?: string; metadata?: Record<string, unknown> }
  | UploadParseError
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return { ok: false, status: 415, error: 'Expected multipart/form-data' };
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return { ok: false, status: 400, error: 'Please upload a file in the "file" field' };
  }

  const shared = parseSharedMultipartFields(form);
  if (!shared.ok) return shared;

  const parsedOcrMode = parseOcrMode(form);
  if (!parsedOcrMode.ok) return parsedOcrMode;

  return { ok: true, file, ocrMode: parsedOcrMode.ocrMode, ...optionalSharedFields(shared) };
}

export async function readImageConvertRequest(request: Request): Promise<
  | { ok: true; file: File; options: ImageConvertOptions; callbackUrl?: string; metadata?: Record<string, unknown> }
  | UploadParseError
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return { ok: false, status: 415, error: 'Expected multipart/form-data' };
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return { ok: false, status: 400, error: 'Please upload a file in the "file" field' };
  }

  const shared = parseSharedMultipartFields(form);
  if (!shared.ok) return shared;

  const options = parseImageConvertOptions(form);
  if (!options.ok) return options;

  return { ok: true, file, options: options.options, ...optionalSharedFields(shared) };
}

function parseSharedMultipartFields(form: FormData): { ok: true; callbackUrl?: string; metadata?: Record<string, unknown> } | UploadParseError {
  const callbackUrl = form.get('callbackUrl');
  if (callbackUrl !== null && typeof callbackUrl !== 'string') {
    return { ok: false, status: 400, error: 'callbackUrl must be a string' };
  }
  if (callbackUrl && !isValidHttpUrl(callbackUrl)) {
    return { ok: false, status: 400, error: 'callbackUrl must be an http(s) URL' };
  }

  const metadataField = form.get('metadata');
  if (metadataField !== null && typeof metadataField !== 'string') {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }
  const metadata = metadataField ? parseMetadata(metadataField) : undefined;
  if (metadataField && !metadata) {
    return { ok: false, status: 400, error: 'metadata must be a JSON object string' };
  }

  return { ok: true, ...(callbackUrl ? { callbackUrl } : {}), ...(metadata ? { metadata } : {}) };
}

function optionalSharedFields(shared: { callbackUrl?: string; metadata?: Record<string, unknown> }) {
  return {
    ...(shared.callbackUrl ? { callbackUrl: shared.callbackUrl } : {}),
    ...(shared.metadata ? { metadata: shared.metadata } : {}),
  };
}

function parseImageConvertOptions(form: FormData): { ok: true; options: ImageConvertOptions } | { ok: false; status: 400; error: string } {
  const targetFormat = form.get('targetFormat');
  const quality = form.get('quality');
  const width = form.get('width');
  const height = form.get('height');
  const fit = form.get('fit');
  if (typeof targetFormat !== 'string') return { ok: false, status: 400, error: 'targetFormat is required' };
  const raw = {
    targetFormat,
    ...(quality !== null ? { quality: numberField(quality) } : {}),
    ...(width !== null ? { width: numberField(width) } : {}),
    ...(height !== null ? { height: numberField(height) } : {}),
    ...(fit !== null ? { fit } : {}),
  };
  if (raw.quality === null) return { ok: false, status: 400, error: 'quality must be a number' };
  if (raw.width === null) return { ok: false, status: 400, error: 'width must be a number' };
  if (raw.height === null) return { ok: false, status: 400, error: 'height must be a number' };
  const parsed = ImageConvertOptionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'Invalid image conversion options' };
  return { ok: true, options: parsed.data };
}

function parseOcrMode(form: FormData): { ok: true; ocrMode: OcrMode } | { ok: false; status: 400; error: string } {
  const value = form.get('ocrMode');
  if (value !== null && typeof value !== 'string') {
    return { ok: false, status: 400, error: 'ocrMode must be a string' };
  }
  const parsed = OcrModeSchema.safeParse(value ?? undefined);
  if (!parsed.success) {
    return { ok: false, status: 400, error: 'ocrMode must be one of fast, balanced, accurate' };
  }
  return { ok: true, ocrMode: parsed.data };
}

function numberField(value: FormDataEntryValue): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function parseMetadata(value: string): Record<string, unknown> | null {
  if (value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
