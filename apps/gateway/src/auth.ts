import type { Context, Next } from 'hono';

export interface AuthEnv {
  ALEPH_OCR_API_KEYS?: string;
}

export function requireApiKey() {
  return async (c: Context<{ Bindings: AuthEnv }>, next: Next) => {
    const configured = parseApiKeys(c.env.ALEPH_OCR_API_KEYS);
    if (configured.size === 0) {
      return c.json({ success: false, error: 'API keys are not configured' }, 500);
    }

    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    if (!token || !configured.has(token)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    return next();
  };
}

function parseApiKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'));
    }
    if (parsed && typeof parsed === 'object') {
      return new Set(Object.values(parsed).filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    // Fallback for comma-separated local values.
  }
  return new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
}
