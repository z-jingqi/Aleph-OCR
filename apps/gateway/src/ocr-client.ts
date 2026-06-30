import {
  EngineInfoSchema,
  MAX_SYNC_IMAGE_SIZE_BYTES,
  OcrResultSchema,
  type EngineInfo,
  type OcrBlock,
  type OcrDocument,
  type OcrPage,
  type OcrResult,
} from '@aleph-tools/shared';
import { OcrEngineError } from './engine-errors';

export { OcrEngineError };

export interface OcrClientEnv {
  GOOGLE_VISION_CREDENTIALS_JSON?: string;
  GOOGLE_VISION_API_KEY?: string;
  GOOGLE_VISION_ENDPOINT?: string;
  MAX_IMAGE_UPLOAD_BYTES?: string;
}

type GoogleCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type GoogleTokenCache = {
  cacheKey: string;
  accessToken: string;
  expiresAtMs: number;
};

type GoogleVisionResponse = {
  responses?: Array<{
    fullTextAnnotation?: GoogleFullTextAnnotation;
    textAnnotations?: Array<{ description?: string }>;
    error?: { code?: number; message?: string; status?: string };
  }>;
  error?: { code?: number; message?: string; status?: string };
};

type GoogleFullTextAnnotation = {
  text?: string;
  pages?: GoogleVisionPage[];
};

type GoogleVisionPage = {
  width?: number;
  height?: number;
  blocks?: GoogleVisionBlock[];
};

type GoogleVisionBlock = {
  boundingBox?: { vertices?: Array<{ x?: number; y?: number }> };
  confidence?: number;
  paragraphs?: Array<{
    words?: Array<{
      symbols?: Array<{ text?: string }>;
    }>;
  }>;
};

let tokenCache: GoogleTokenCache | null = null;

export async function getEngineInfo(env: OcrClientEnv): Promise<EngineInfo> {
  return EngineInfoSchema.parse({
    engine: 'google-vision',
    engineVersion: 'v1',
    provider: 'google-vision',
    feature: 'DOCUMENT_TEXT_DETECTION',
    capabilities: {
      image: true,
      pdf: false,
      autoImageConversion: true,
      asyncJobs: true,
      layout: true,
      tables: false,
    },
    limits: {
      maxSyncImageSizeBytes: MAX_SYNC_IMAGE_SIZE_BYTES,
      maxImageUploadBytes: maxImageUploadBytes(env),
    },
  });
}

export async function ocrImage(env: OcrClientEnv, file: File, inputMetadata?: { converted?: boolean; originalMimeType?: string }): Promise<OcrResult> {
  const started = Date.now();
  const visionStarted = Date.now();
  const response = await fetchGoogleVision(env, file);
  const normalizeStarted = Date.now();
  const result = normalizeGoogleVisionResult(response, {
    filename: file.name || 'image',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    converted: inputMetadata?.converted ?? false,
    ...(inputMetadata?.originalMimeType ? { originalMimeType: inputMetadata.originalMimeType } : {}),
  });
  const finished = Date.now();
  result.metadata.timingsMs = {
    googleVision: normalizeStarted - visionStarted,
    normalize: finished - normalizeStarted,
    total: finished - started,
  };
  return OcrResultSchema.parse(result);
}

async function fetchGoogleVision(env: OcrClientEnv, file: File): Promise<GoogleVisionResponse> {
  const endpoint = env.GOOGLE_VISION_ENDPOINT ?? 'https://vision.googleapis.com/v1/images:annotate';
  const url = new URL(endpoint);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (env.GOOGLE_VISION_CREDENTIALS_JSON) {
    headers.set('Authorization', `Bearer ${await getAccessToken(env.GOOGLE_VISION_CREDENTIALS_JSON)}`);
  } else if (env.GOOGLE_VISION_API_KEY) {
    url.searchParams.set('key', env.GOOGLE_VISION_API_KEY);
  } else {
    throw new OcrEngineError('Google Vision credentials are not configured', 503, 'ENGINE_UNAVAILABLE', false);
  }

  const body = {
    requests: [
      {
        image: { content: arrayBufferToBase64(await file.arrayBuffer()) },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    throw new OcrEngineError(`Google Vision is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`, 503, 'ENGINE_UNAVAILABLE', true);
  }

  const data = await response.json().catch(() => null) as GoogleVisionResponse | null;
  if (!response.ok || data?.error) {
    throw googleErrorToOcrError(data?.error, response.status);
  }
  const first = data?.responses?.[0];
  if (!first) throw new OcrEngineError('Google Vision returned an empty response', 502, 'ENGINE_UNAVAILABLE', true);
  if (first.error) throw googleErrorToOcrError(first.error, first.error.code ?? 503);
  return data;
}

function normalizeGoogleVisionResult(
  response: GoogleVisionResponse,
  input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    converted: boolean;
    originalMimeType?: string;
  },
): OcrResult {
  const annotation = response.responses?.[0]?.fullTextAnnotation;
  const fallbackText = response.responses?.[0]?.textAnnotations?.[0]?.description ?? '';
  const text = annotation?.text ?? fallbackText;
  const googlePages = annotation?.pages?.length ? annotation.pages : [{ width: 0, height: 0, blocks: [] }];
  const pages = googlePages.map((page, index): OcrPage => {
    const blocks = (page.blocks ?? []).map(normalizeBlock).filter((block): block is OcrBlock => block !== null);
    return {
      pageIndex: index,
      width: page.width ?? 0,
      height: page.height ?? 0,
      text: index === 0 ? text : blocks.map((block) => block.text).join('\n'),
      blocks,
      tables: [],
      confidence: averageConfidence(blocks),
    };
  });
  const document: OcrDocument = {
    type: 'image',
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  };
  return {
    status: 'ready',
    engine: 'google-vision',
    engineVersion: 'v1',
    document,
    pages,
    plainText: pages.map((page) => page.text).filter(Boolean).join('\n\n'),
    markdown: pages.map((page) => page.text).filter(Boolean).join('\n\n'),
    metadata: {
      provider: 'google-vision',
      feature: 'DOCUMENT_TEXT_DETECTION',
      input: {
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        converted: input.converted,
        ...(input.originalMimeType ? { originalMimeType: input.originalMimeType } : {}),
      },
    },
  };
}

function normalizeBlock(block: GoogleVisionBlock): OcrBlock | null {
  const text = (block.paragraphs ?? [])
    .flatMap((paragraph) => paragraph.words ?? [])
    .map((word) => (word.symbols ?? []).map((symbol) => symbol.text ?? '').join(''))
    .filter(Boolean)
    .join(' ');
  if (!text) return null;
  const bbox = block.boundingBox?.vertices?.flatMap((vertex) => [vertex.x ?? 0, vertex.y ?? 0]);
  return {
    text,
    ...(bbox && bbox.length >= 8 ? { bbox } : {}),
    confidence: typeof block.confidence === 'number' ? block.confidence : null,
  };
}

function averageConfidence(blocks: OcrBlock[]): number | null {
  const values = blocks.map((block) => block.confidence).filter((value): value is number => typeof value === 'number');
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function googleErrorToOcrError(error: { code?: number; message?: string; status?: string } | undefined, fallbackStatus: number): OcrEngineError {
  const status = error?.status;
  const code = error?.code;
  const message = error?.message ?? 'Google Vision request failed';
  if (status === 'INVALID_ARGUMENT' || code === 3) return new OcrEngineError(message, 400, 'VALIDATION_ERROR', false);
  if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED' || code === 7 || code === 16) {
    return new OcrEngineError(message, 503, 'ENGINE_UNAVAILABLE', false);
  }
  if (status === 'RESOURCE_EXHAUSTED' || code === 8) return new OcrEngineError(message, 429, 'RATE_LIMITED', true);
  if (status === 'DEADLINE_EXCEEDED' || status === 'UNAVAILABLE' || status === 'INTERNAL' || code === 4 || code === 13 || code === 14) {
    return new OcrEngineError(message, 503, 'ENGINE_UNAVAILABLE', true);
  }
  const httpStatus = fallbackStatus >= 400 && fallbackStatus < 500 ? 400 : 503;
  return new OcrEngineError(message, httpStatus, httpStatus >= 500 ? 'ENGINE_UNAVAILABLE' : 'VALIDATION_ERROR', httpStatus >= 500);
}

async function getAccessToken(credentialsJson: string): Promise<string> {
  const credentials = parseCredentials(credentialsJson);
  const cacheKey = credentials.client_email;
  const now = Date.now();
  if (tokenCache?.cacheKey === cacheKey && tokenCache.expiresAtMs - 60_000 > now) {
    return tokenCache.accessToken;
  }

  const assertion = await signJwt(credentials);
  const tokenUri = credentials.token_uri ?? 'https://oauth2.googleapis.com/token';
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json().catch(() => null) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!response.ok || !data?.access_token) {
    throw new OcrEngineError(data?.error_description ?? 'Could not obtain Google access token', 503, 'ENGINE_UNAVAILABLE', false);
  }
  tokenCache = {
    cacheKey,
    accessToken: data.access_token,
    expiresAtMs: now + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

function parseCredentials(value: string): GoogleCredentials {
  try {
    const parsed = JSON.parse(value) as Partial<GoogleCredentials>;
    if (typeof parsed.client_email === 'string' && typeof parsed.private_key === 'string') {
      return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
    }
  } catch {
    // handled below
  }
  throw new OcrEngineError('GOOGLE_VISION_CREDENTIALS_JSON is invalid', 503, 'ENGINE_UNAVAILABLE', false);
}

async function signJwt(credentials: GoogleCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlJson({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: credentials.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const payload = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(credentials.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function maxImageUploadBytes(env: OcrClientEnv): number {
  const parsed = Number(env.MAX_IMAGE_UPLOAD_BYTES ?? MAX_SYNC_IMAGE_SIZE_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : MAX_SYNC_IMAGE_SIZE_BYTES;
}
