export type UploadParseError = { ok: false; status: 400 | 413 | 415; error: string };

const MAX_METADATA_FIELD_BYTES = 4096;

export async function readUploadedFile(request: Request): Promise<
  | { ok: true; file: File; callbackUrl?: string; metadata?: Record<string, unknown> }
  | UploadParseError
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return { ok: false, status: 415, error: 'Expected multipart/form-data' };
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return { ok: false, status: 400, error: 'Please upload a file in the "file" field' };
  }
  const unsupportedField = firstUnsupportedField(form);
  if (unsupportedField) {
    return { ok: false, status: 400, error: `Unsupported OCR upload field: ${unsupportedField}` };
  }

  const shared = parseSharedMultipartFields(form);
  if (!shared.ok) return shared;
  return { ok: true, file, ...optionalSharedFields(shared) };
}

function firstUnsupportedField(form: FormData): string | null {
  const allowed = new Set(['file', 'callbackUrl', 'metadata']);
  for (const key of form.keys()) {
    if (!allowed.has(key)) return key;
  }
  return null;
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
  if (metadataField && new TextEncoder().encode(metadataField).byteLength > MAX_METADATA_FIELD_BYTES) {
    return { ok: false, status: 400, error: `metadata must be ${MAX_METADATA_FIELD_BYTES} bytes or fewer` };
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

function parseMetadata(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
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
