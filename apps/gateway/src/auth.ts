import type { Context, Next } from 'hono';
import type { ApiErrorCode } from '@aleph-tools/shared';

export interface AuthEnv {
  ALEPH_TOOLS_API_KEYS?: string;
  ALEPH_OCR_API_KEYS?: string;
}

export type AuthVariables = {
  clientId: string;
  requestId: string;
};

export function requireApiKey() {
  return async (c: Context<{ Bindings: AuthEnv; Variables: AuthVariables }>, next: Next) => {
    const configured = parseApiKeys(c.env.ALEPH_TOOLS_API_KEYS ?? c.env.ALEPH_OCR_API_KEYS);
    if (configured.length === 0) {
      return authError(c, 'INTERNAL_ERROR', 'API keys are not configured', 500, false);
    }

    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    const credential = token ? await findCredential(configured, token) : null;
    if (!credential) {
      return authError(c, 'UNAUTHORIZED', 'Unauthorized', 401, false);
    }

    c.set('clientId', credential.clientId);
    return next();
  };
}

function authError(
  c: Context<{ Bindings: AuthEnv; Variables: AuthVariables }>,
  code: ApiErrorCode,
  message: string,
  httpStatus: 401 | 500,
  retryable: boolean,
) {
  const requestId = c.get('requestId') || `req_${crypto.randomUUID()}`;
  return c.json(
    {
      success: false,
      error: {
        code,
        message,
        httpStatus,
        requestId,
        retryable,
        terminal: false,
      },
      requestId,
    },
    httpStatus,
  );
}

export function parseApiKeys(raw: string | undefined): Array<{ clientId: string; key: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map((key, index) => ({ clientId: `client-${index + 1}`, key }));
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
        .map(([clientId, key]) => ({ clientId, key }));
    }
  } catch {
    // Fallback for comma-separated local values.
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((key, index) => ({ clientId: `client-${index + 1}`, key }));
}

async function findCredential(
  credentials: Array<{ clientId: string; key: string }>,
  token: string,
): Promise<{ clientId: string; key: string } | null> {
  for (const credential of credentials) {
    if (await timingSafeEqual(credential.key, token)) return credential;
  }
  return null;
}

async function timingSafeEqual(expected: string, actual: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  const expectedDigest = await crypto.subtle.digest('SHA-256', expectedBytes);
  const actualDigest = await crypto.subtle.digest('SHA-256', actualBytes);
  return buffersEqual(new Uint8Array(expectedDigest), new Uint8Array(actualDigest));
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}
