import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function fixtureFile(relativePath: string, mimeType: string): Promise<File> {
  const absolute = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', relativePath);
  const bytes = await readFile(absolute);
  return new File([bytes], relativePath.split('/').at(-1) ?? 'fixture', { type: mimeType });
}
