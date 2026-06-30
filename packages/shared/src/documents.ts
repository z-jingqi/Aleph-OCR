import { z } from 'zod';

export const DocumentTypeSchema = z.literal('image');
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const OcrDocumentSchema = z.object({
  type: DocumentTypeSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type OcrDocument = z.infer<typeof OcrDocumentSchema>;

export type ImageInputFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'heic' | 'heif' | 'avif';

const IMAGE_FORMAT_MIME_TYPES: Record<ImageInputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

const MIME_TO_IMAGE_FORMAT = new Map<string, ImageInputFormat>([
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/tiff', 'tiff'],
  ['image/x-tiff', 'tiff'],
  ['image/bmp', 'bmp'],
  ['image/x-ms-bmp', 'bmp'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
  ['image/avif', 'avif'],
]);

const EXTENSION_TO_IMAGE_FORMAT = new Map<string, ImageInputFormat>([
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['png', 'png'],
  ['gif', 'gif'],
  ['webp', 'webp'],
  ['tif', 'tiff'],
  ['tiff', 'tiff'],
  ['bmp', 'bmp'],
  ['heic', 'heic'],
  ['heif', 'heif'],
  ['avif', 'avif'],
]);

const KNOWN_IMAGE_EXTENSIONS = new Set([...EXTENSION_TO_IMAGE_FORMAT.keys(), 'svg']);

const GOOGLE_VISION_NATIVE_IMAGE_FORMATS = new Set<ImageInputFormat>(['jpeg', 'png', 'gif', 'webp', 'tiff', 'bmp']);
const CLOUDFLARE_IMAGES_CONVERTIBLE_FORMATS = new Set<ImageInputFormat>([
  'jpeg',
  'png',
  'gif',
  'webp',
  'tiff',
  'bmp',
  'heic',
  'heif',
  'avif',
]);

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

export function isGoogleVisionNativeImageFile(mimeType: string, filename = ''): boolean {
  const format = imageFormatFromFile(mimeType, filename);
  return format !== null && GOOGLE_VISION_NATIVE_IMAGE_FORMATS.has(format);
}

export function isImageConversionInputFile(mimeType: string, filename = ''): boolean {
  const format = imageFormatFromFile(mimeType, filename);
  return format !== null && CLOUDFLARE_IMAGES_CONVERTIBLE_FORMATS.has(format);
}

export function isSupportedImageMime(mimeType: string): boolean {
  return isImageConversionInputFile(mimeType);
}

export function inferDocumentType(mimeType: string, filename = ''): DocumentType | null {
  if (isImageFile(mimeType, filename)) return 'image';
  return null;
}
