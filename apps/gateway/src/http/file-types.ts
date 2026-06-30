import {
  imageFormatFromFile,
  isImageConversionInputFile,
  isImageFile,
  isGoogleVisionNativeImageFile,
  normalizedImageMimeType,
} from '@aleph-tools/shared';

export function normalizeImageUploadFile(file: File): File {
  const mimeType = normalizedImageMimeType(file.type, file.name);
  if (!mimeType || mimeType === file.type) return file;
  return new File([file], file.name || 'image', { type: mimeType });
}

export function imageUploadKind(file: File): 'not_image' | 'unknown_image' | 'convertible' | 'ocr_native' {
  if (!isImageFile(file.type, file.name)) return 'not_image';
  if (isGoogleVisionNativeImageFile(file.type, file.name)) return 'ocr_native';
  if (isImageConversionInputFile(file.type, file.name)) return 'convertible';
  return 'unknown_image';
}

export function validateOcrImageInput(file: File): string | null {
  const kind = imageUploadKind(file);
  if (kind === 'not_image') return 'OCR only accepts image files';
  if (kind === 'unknown_image') return `Unsupported image format: ${file.type || imageFormatFromFile(file.type, file.name) || 'unknown'}`;
  return null;
}

export function shouldConvertForOcr(file: File): boolean {
  return !isGoogleVisionNativeImageFile(file.type, file.name);
}

export function fileInfo(file: File) {
  return {
    filename: file.name || 'image',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    ...(imageFormatFromFile(file.type, file.name) ? { format: imageFormatFromFile(file.type, file.name) as string } : {}),
  };
}
