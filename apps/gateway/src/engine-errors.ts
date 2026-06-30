import type { ApiErrorCode } from '@aleph-tools/shared';

export class OcrEngineError extends Error {
  constructor(
    message: string,
    public status = 503,
    public code: ApiErrorCode = 'ENGINE_UNAVAILABLE',
    public retryable = status >= 500,
  ) {
    super(message);
    this.name = 'OcrEngineError';
  }
}
