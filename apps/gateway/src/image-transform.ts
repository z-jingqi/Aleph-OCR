import { imageFormatFromFile } from '@aleph-tools/shared';
import { OcrEngineError } from './engine-errors';

export type ImageTransformEnv = {
  IMAGES?: ImagesBinding;
};

export type ConvertedImage = {
  file: File;
  converted: boolean;
  originalMimeType?: string;
};

export async function convertImageForOcr(env: ImageTransformEnv, file: File): Promise<ConvertedImage> {
  if (!env.IMAGES) {
    throw new OcrEngineError('Cloudflare Images binding is not configured', 503, 'ENGINE_UNAVAILABLE', true);
  }

  let output: ImageTransformationResult;
  try {
    output = await env.IMAGES
      .input(file.stream())
      .output({ format: 'image/jpeg', quality: 90, background: '#ffffff', anim: false });
  } catch (error) {
    throw new OcrEngineError(
      `Image format is not supported for OCR conversion: ${error instanceof Error ? error.message : 'unknown conversion error'}`,
      400,
      'UNSUPPORTED_FORMAT',
      false,
    );
  }

  const bytes = await new Response(output.image()).arrayBuffer();
  const filename = convertedFilename(file.name);
  return {
    file: new File([bytes], filename, { type: output.contentType() || 'image/jpeg' }),
    converted: true,
    originalMimeType: file.type || undefined,
  };
}

function convertedFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '') || 'image';
  const originalFormat = imageFormatFromFile('', filename);
  const suffix = originalFormat ? `.from-${originalFormat}` : '';
  return `${base}${suffix}.jpg`;
}
