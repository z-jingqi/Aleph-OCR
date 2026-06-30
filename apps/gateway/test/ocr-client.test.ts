import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEngineInfo, ocrImage, OcrEngineError } from '../src/ocr-client';
import { sampleGoogleVisionResponse } from './helpers';

describe('Google Vision OCR client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports image-only Google Vision engine info', async () => {
    await expect(getEngineInfo({ GOOGLE_VISION_API_KEY: 'key' })).resolves.toMatchObject({
      engine: 'google-vision',
      provider: 'google-vision',
      feature: 'DOCUMENT_TEXT_DETECTION',
      capabilities: { image: true, pdf: false, autoImageConversion: true, asyncJobs: true, tables: false },
    });
  });

  it('calls Google Vision image annotation and normalizes text blocks', async () => {
    const fetchMock = vi.fn(async () => Response.json(sampleGoogleVisionResponse('STORE TOTAL 12.00')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ocrImage({ GOOGLE_VISION_API_KEY: 'vision-key' }, new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const request = fetchMock.mock.calls[0]![0] as string;
    expect(new URL(request).searchParams.get('key')).toBe('vision-key');
    expect(result).toMatchObject({
      engine: 'google-vision',
      document: { type: 'image', filename: 'receipt.jpg', mimeType: 'image/jpeg' },
      plainText: 'STORE TOTAL 12.00',
      metadata: {
        provider: 'google-vision',
        feature: 'DOCUMENT_TEXT_DETECTION',
        input: { converted: false },
      },
    });
    expect(result.pages[0]?.blocks[0]).toMatchObject({ text: 'STORE TOTAL 12.00', confidence: 0.95 });
  });

  it('marks converted inputs in OCR metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(sampleGoogleVisionResponse('converted text'))));

    const result = await ocrImage(
      { GOOGLE_VISION_API_KEY: 'vision-key' },
      new File(['jpeg'], 'receipt.from-heic.jpg', { type: 'image/jpeg' }),
      { converted: true, originalMimeType: 'image/heic' },
    );

    expect(result.metadata.input).toMatchObject({
      converted: true,
      originalMimeType: 'image/heic',
      mimeType: 'image/jpeg',
    });
  });

  it('maps Google quota errors to RATE_LIMITED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } },
      { status: 429 },
    )));

    await expect(ocrImage({ GOOGLE_VISION_API_KEY: 'vision-key' }, new File(['x'], 'receipt.jpg', { type: 'image/jpeg' }))).rejects.toMatchObject({
      name: 'OcrEngineError',
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
    } satisfies Partial<OcrEngineError>);
  });

  it('maps numeric Google invalid argument errors to non-retryable validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      responses: [{ error: { code: 3, message: 'bad image data' } }],
    })));

    await expect(ocrImage({ GOOGLE_VISION_API_KEY: 'vision-key' }, new File(['x'], 'receipt.jpg', { type: 'image/jpeg' }))).rejects.toMatchObject({
      name: 'OcrEngineError',
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    } satisfies Partial<OcrEngineError>);
  });

  it('fails clearly when credentials are missing', async () => {
    await expect(ocrImage({}, new File(['x'], 'receipt.jpg', { type: 'image/jpeg' }))).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      retryable: false,
    });
  });
});
