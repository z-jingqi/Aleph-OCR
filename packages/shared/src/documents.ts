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

export function isSupportedImageMime(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp', 'image/heic', 'image/heif'].includes(mimeType);
}

export function isSupportedPdfMime(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

export function inferDocumentType(mimeType: string): DocumentType | null {
  if (isSupportedImageMime(mimeType)) return 'image';
  if (isSupportedPdfMime(mimeType)) return 'pdf';
  return null;
}
