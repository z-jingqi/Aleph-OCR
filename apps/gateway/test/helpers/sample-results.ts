export function sampleGoogleVisionResponse(text = 'Aleph OCR result') {
  return {
    responses: [
      {
        fullTextAnnotation: {
          text,
          pages: [
            {
              width: 100,
              height: 100,
              blocks: [
                {
                  confidence: 0.95,
                  boundingBox: { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }] },
                  paragraphs: [
                    {
                      words: text.split(/\s+/).map((word) => ({
                        symbols: [...word].map((character) => ({ text: character })),
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}
