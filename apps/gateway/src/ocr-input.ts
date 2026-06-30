import { normalizeImageUploadFile, shouldConvertForOcr } from './http/file-types';
import { convertImageForOcr } from './image-transform';
import type { Env } from './types';

export type PreparedOcrInput = {
  file: File;
  converted: boolean;
  originalMimeType?: string;
};

export async function prepareOcrInput(env: Env, file: File): Promise<PreparedOcrInput> {
  const normalized = normalizeImageUploadFile(file);
  if (!shouldConvertForOcr(normalized)) {
    return { file: normalized, converted: false };
  }
  return convertImageForOcr(env, normalized);
}
