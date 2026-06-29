import {
  imageFormatFromFile,
  isImageConversionInputFile,
  isImageFile,
  isOcrNativeImageFile,
  normalizedImageMimeType,
  type ImagePipelineOptions,
} from '@aleph-tools/shared';

export function normalizeImageUploadFile(file: File): File {
  const mimeType = normalizedImageMimeType(file.type, file.name);
  if (!mimeType || mimeType === file.type) return file;
  return new File([file], file.name || 'image', { type: mimeType });
}

export function imageUploadKind(file: File): 'not_image' | 'unknown_image' | 'convertible' | 'ocr_native' {
  if (!isImageFile(file.type, file.name)) return 'not_image';
  if (isOcrNativeImageFile(file.type, file.name)) return 'ocr_native';
  if (isImageConversionInputFile(file.type, file.name)) return 'convertible';
  return 'unknown_image';
}

export function validatePipelineImageInput(file: File, options: ImagePipelineOptions): string | null {
  const kind = imageUploadKind(file);
  if (kind === 'not_image') return 'Pipeline only accepts image files';
  if (kind === 'unknown_image') return `Unsupported image format: ${file.type || imageFormatFromFile(file.type, file.name) || 'unknown'}`;
  if (!options.convert.enabled && kind !== 'ocr_native') {
    return 'Image format is not supported by OCR when conversion is disabled';
  }
  return null;
}

export function shouldConvertForOcr(file: File, options: ImagePipelineOptions): boolean {
  return options.convert.enabled && !isOcrNativeImageFile(file.type, file.name);
}

export function fileInfo(file: File) {
  return {
    filename: file.name || 'image',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    ...(imageFormatFromFile(file.type, file.name) ? { format: imageFormatFromFile(file.type, file.name) as string } : {}),
  };
}
