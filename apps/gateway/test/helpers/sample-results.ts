export function sampleOcrResult(document = { type: 'image', filename: 'receipt.png', mimeType: 'image/png', sizeBytes: 3 }) {
  return {
    engine: 'mock',
    engineVersion: '1',
    document,
    pages: [{ pageIndex: 0, width: 100, height: 100, text: 'Aleph OCR result', blocks: [], tables: [], confidence: 0.95 }],
    plainText: 'Aleph OCR result',
    markdown: 'Aleph OCR result',
  };
}
