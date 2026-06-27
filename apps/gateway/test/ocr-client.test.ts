import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEngineInfo, getPdfInfoFromObject, ocrImage, ocrPdf, ocrPdfBatchFromObject, ocrPdfPage } from '../src/ocr-client';

const engineInfo = {
  engine: 'paddleocr',
  engineVersion: '3.x',
  ocrModes: ['fast', 'balanced', 'accurate'],
  defaultOcrMode: 'balanced',
  modeConfigs: {
    fast: { pdfRenderDpi: 160 },
    balanced: { pdfRenderDpi: 200 },
    accurate: { pdfRenderDpi: 240 },
  },
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

const ocrResult = {
  engine: 'mock',
  engineVersion: '1',
  document: { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 },
  pages: [{ pageIndex: 0, width: 100, height: 100, text: 'Aleph OCR result', blocks: [], tables: [], confidence: 0.95 }],
  plainText: 'Aleph OCR result',
  markdown: 'Aleph OCR result',
};

describe('tools engine client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    await expect(getEngineInfo(env)).resolves.toMatchObject({
      engine: 'paddleocr',
      modes: ['fast', 'balanced', 'accurate'],
      defaultMode: 'balanced',
      modeConfig: { accurate: { pdfRenderDpi: 240 } },
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(new URL(containerFetch.mock.calls[0]![0].url).pathname).toBe('/health');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps HTTP engine URL support for local development when no container binding is configured', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(engineInfo));

    await expect(getEngineInfo({ ALEPH_TOOLS_ENGINE_URL: 'https://external-engine.example.com' })).resolves.toMatchObject({
      engine: 'paddleocr',
      modes: ['fast', 'balanced', 'accurate'],
      defaultMode: 'balanced',
    });
    expect(globalFetch).toHaveBeenCalledWith('https://external-engine.example.com/health', expect.any(Object));
  });

  it('sends only the tools internal token header', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Aleph-Tools-Internal-Token')).toBe('internal-token');
      expect([...headers.keys()].some((name) => name.startsWith('x-aleph-') && name.includes('ocr'))).toBe(false);
      return Response.json(engineInfo);
    });

    await getEngineInfo({ ALEPH_TOOLS_ENGINE_URL: 'https://external-engine.example.com', TOOLS_ENGINE_TOKEN: 'internal-token' });

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('passes OCR mode as a query parameter to image and PDF endpoints', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(ocrResult));
    const file = new File(['abc'], 'receipt.png', { type: 'image/png' });
    const pdf = new File(['pdf'], 'mixed.pdf', { type: 'application/pdf' });

    await ocrImage({ ALEPH_TOOLS_ENGINE_URL: 'https://engine.example.com' }, file, 'fast');
    await ocrPdf({ ALEPH_TOOLS_ENGINE_URL: 'https://engine.example.com' }, pdf, 'accurate');
    await ocrPdfPage({ ALEPH_TOOLS_ENGINE_URL: 'https://engine.example.com' }, pdf, 2, 'balanced');

    const urls = globalFetch.mock.calls.map((call) => requestUrl(call[0]));
    expect(urls.map((url) => url.pathname)).toEqual(['/internal/ocr/image', '/internal/ocr/pdf', '/internal/ocr/pdf-page']);
    expect(urls[0].searchParams.get('mode')).toBe('fast');
    expect(urls[1].searchParams.get('mode')).toBe('accurate');
    expect(urls[2].searchParams.get('page_index')).toBe('2');
    expect(urls[2].searchParams.get('mode')).toBe('balanced');
  });

  it('streams raw PDF bodies to internal info and batch endpoints', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      expect(init?.body).toBeInstanceOf(ReadableStream);
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/pdf');
      if (url.pathname === '/internal/ocr/pdf-info') return Response.json({ pageCount: 7 });
      return Response.json({ ...ocrResult, document: { type: 'pdf', filename: 'mixed.pdf', mimeType: 'application/pdf', sizeBytes: 3 } });
    });

    const infoObject = { body: new Blob(['pdf-info']).stream() };
    const batchObject = { body: new Blob(['pdf-batch']).stream() };

    await expect(getPdfInfoFromObject({ ALEPH_TOOLS_ENGINE_URL: 'https://engine.example.com' }, infoObject, 'mixed.pdf')).resolves.toEqual({
      pageCount: 7,
    });
    await expect(ocrPdfBatchFromObject({ ALEPH_TOOLS_ENGINE_URL: 'https://engine.example.com' }, batchObject, 'mixed.pdf', 5, 2, 'balanced')).resolves.toMatchObject({
      document: { type: 'pdf' },
    });

    const urls = globalFetch.mock.calls.map((call) => requestUrl(call[0]));
    expect(urls.map((url) => url.pathname)).toEqual(['/internal/ocr/pdf-info', '/internal/ocr/pdf-batch']);
    expect(urls[0].searchParams.get('filename')).toBe('mixed.pdf');
    expect(urls[1].searchParams.get('start_page')).toBe('5');
    expect(urls[1].searchParams.get('page_count')).toBe('2');
    expect(urls[1].searchParams.get('mode')).toBe('balanced');
  });

  it('streams raw PDF batches through the internal container binding', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const containerFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/internal/ocr/pdf-batch');
      expect(url.searchParams.get('start_page')).toBe('0');
      expect(url.searchParams.get('page_count')).toBe('1');
      expect(url.searchParams.get('mode')).toBe('fast');
      expect(request.headers.get('Content-Type')).toBe('application/pdf');
      expect(request.body).toBeInstanceOf(ReadableStream);
      return Response.json({ ...ocrResult, document: { type: 'pdf', filename: 'mixed.pdf', mimeType: 'application/pdf', sizeBytes: 3 } });
    });
    const env = {
      ALEPH_TOOLS_ENGINE_URL: 'https://external-engine.example.com',
      TOOLS_ENGINE: {
        getByName(name: string) {
          expect(name).toBe('shared');
          return { fetch: containerFetch };
        },
      },
    };

    await expect(ocrPdfBatchFromObject(env, { body: new Blob(['pdf']).stream() }, 'mixed.pdf', 0, 1, 'fast')).resolves.toMatchObject({
      document: { type: 'pdf' },
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

function requestUrl(input: unknown): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}
