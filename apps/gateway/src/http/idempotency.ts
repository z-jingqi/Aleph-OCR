export function normalizeIdempotencyKey(value: string | undefined): string | undefined | null {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 256) return null;
  return trimmed;
}

export async function buildIdempotencyFingerprint(file: File, tool: string, operation: string, options: Record<string, unknown>): Promise<string> {
  const payload = stableStringify({
    filename: file.name || 'upload',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    tool,
    operation,
    options,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${toHex(digest)}`;
}

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
