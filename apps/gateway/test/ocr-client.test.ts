import { describe, expect, it, vi } from 'vitest';
import { getEngineInfo } from '../src/ocr-client';

const engineInfo = {
  engine: 'paddleocr',
  engineVersion: '3.x',
  capabilities: {
    image: true,
    pdf: true,
    syncImage: true,
    imageConvert: true,
    imageConvertFormats: ['png', 'jpeg', 'webp', 'avif'],
    asyncJobs: true,
    layout: true,
    tables: false,
  },
  limits: {
    maxSyncImageSizeBytes: 10 * 1024 * 1024,
    maxPdfPages: 100,
    pdfBatchSize: 1,
    pdfRenderDpi: 200,
  },
};

describe('tools engine client', () => {
  it('prefers the internal container binding when available', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const containerFetch = vi.fn(async (request: Request) => Response.json({ ...engineInfo, requestedPath: new URL(request.url).pathname }));
    const env = {
      ALEPH_TOOLS_ENGINE_URL: 'https://external-engine.example.com',
      TOOLS_ENGINE: {
        getByName(name: string) {
          expect(name).toBe('shared');
          return { fetch: containerFetch };
        },
      },
    };

    await expect(getEngineInfo(env)).resolves.toMatchObject({ engine: 'paddleocr' });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(new URL(containerFetch.mock.calls[0]![0].url).pathname).toBe('/health');
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('keeps HTTP engine URL support for local development when no container binding is configured', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(engineInfo));

    await expect(getEngineInfo({ ALEPH_TOOLS_ENGINE_URL: 'https://external-engine.example.com' })).resolves.toMatchObject({
      engine: 'paddleocr',
    });
    expect(globalFetch).toHaveBeenCalledWith('https://external-engine.example.com/health', expect.any(Object));
    globalFetch.mockRestore();
  });
});
