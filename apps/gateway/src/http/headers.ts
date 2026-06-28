export function escapeHeaderFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}
