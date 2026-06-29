import { z } from 'zod';

export const DocumentTypeSchema = z.enum(['image', 'pdf']);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const OcrDocumentSchema = z.object({
  type: DocumentTypeSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type OcrDocument = z.infer<typeof OcrDocumentSchema>;

export type ImageInputFormat = 'jpeg' | 'png' | 'webp' | 'tiff' | 'bmp' | 'heic' | 'heif';

const IMAGE_FORMAT_MIME_TYPES: Record<ImageInputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
};

const MIME_TO_IMAGE_FORMAT = new Map<string, ImageInputFormat>([
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/tiff', 'tiff'],
  ['image/x-tiff', 'tiff'],
  ['image/bmp', 'bmp'],
  ['image/x-ms-bmp', 'bmp'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
]);

const EXTENSION_TO_IMAGE_FORMAT = new Map<string, ImageInputFormat>([
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['png', 'png'],
  ['webp', 'webp'],
  ['tif', 'tiff'],
  ['tiff', 'tiff'],
  ['bmp', 'bmp'],
  ['heic', 'heic'],
  ['heif', 'heif'],
]);

const KNOWN_IMAGE_EXTENSIONS = new Set([
  ...EXTENSION_TO_IMAGE_FORMAT.keys(),
  'avif',
  'gif',
  'svg',
]);

const OCR_NATIVE_IMAGE_FORMATS = new Set<ImageInputFormat>(['jpeg', 'png', 'tiff', 'bmp']);
const CONVERTIBLE_IMAGE_FORMATS = new Set<ImageInputFormat>(['jpeg', 'png', 'webp', 'tiff', 'bmp', 'heic', 'heif']);

export function imageFormatFromFile(mimeType: string, filename = ''): ImageInputFormat | null {
  const normalizedMime = mimeType.trim().toLowerCase();
  const byMime = MIME_TO_IMAGE_FORMAT.get(normalizedMime);
  if (byMime) return byMime;
  const extension = filename.split('.').pop()?.trim().toLowerCase() ?? '';
  return EXTENSION_TO_IMAGE_FORMAT.get(extension) ?? null;
}

export function normalizedImageMimeType(mimeType: string, filename = ''): string | null {
  const format = imageFormatFromFile(mimeType, filename);
  if (format) return IMAGE_FORMAT_MIME_TYPES[format];
  return mimeType.toLowerCase().startsWith('image/') ? mimeType : null;
}

export function isImageFile(mimeType: string, filename = ''): boolean {
  const extension = filename.split('.').pop()?.trim().toLowerCase() ?? '';
  return mimeType.toLowerCase().startsWith('image/') || imageFormatFromFile(mimeType, filename) !== null || KNOWN_IMAGE_EXTENSIONS.has(extension);
}

export function isOcrNativeImageFile(mimeType: string, filename = ''): boolean {
  const format = imageFormatFromFile(mimeType, filename);
  return format !== null && OCR_NATIVE_IMAGE_FORMATS.has(format);
}

export function isImageConversionInputFile(mimeType: string, filename = ''): boolean {
  const format = imageFormatFromFile(mimeType, filename);
  return format !== null && CONVERTIBLE_IMAGE_FORMATS.has(format);
}

export function isSupportedImageMime(mimeType: string): boolean {
  return isImageConversionInputFile(mimeType);
}

export function isSupportedPdfMime(mimeType: string, filename = ''): boolean {
  return mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
}

export function inferDocumentType(mimeType: string, filename = ''): DocumentType | null {
  if (isOcrNativeImageFile(mimeType, filename)) return 'image';
  if (isSupportedPdfMime(mimeType, filename)) return 'pdf';
  return null;
}
