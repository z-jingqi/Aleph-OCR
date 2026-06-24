import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [environment] = process.argv.slice(2);

if (!environment || !['dev', 'prod'].includes(environment)) {
  throw new Error('Usage: node scripts/prepare-wrangler-config.mjs <dev|prod>');
}

const suffix = environment.toUpperCase();
const appDir = resolve(repoRoot, 'apps', 'gateway');
const values = {
  __ENV__: environment,
  __OCR_DOMAIN__: environment === 'prod' ? 'ocr.aleph-cat.com' : 'ocr.dev.aleph-cat.com',
  __OCR_ENGINE_URL__: process.env[`ALEPH_OCR_ENGINE_URL_${suffix}`] ?? '__OCR_ENGINE_URL__',
  __D1_DATABASE_ID__: process.env[`ALEPH_OCR_D1_DATABASE_ID_${suffix}`] ?? '__D1_DATABASE_ID__',
  __R2_BUCKET__: process.env[`ALEPH_OCR_R2_BUCKET_${suffix}`] ?? `aleph-ocr-assets-${environment}`,
  __QUEUE__: process.env[`ALEPH_OCR_QUEUE_${suffix}`] ?? `aleph-ocr-jobs-${environment}`,
};

for (const name of ['__OCR_ENGINE_URL__', '__D1_DATABASE_ID__']) {
  if (values[name] === name) {
    const envName = name === '__OCR_ENGINE_URL__' ? `ALEPH_OCR_ENGINE_URL_${suffix}` : `ALEPH_OCR_D1_DATABASE_ID_${suffix}`;
    throw new Error(`${envName} is required.`);
  }
}

let config = await readFile(resolve(appDir, 'wrangler.template.jsonc'), 'utf8');
for (const [token, value] of Object.entries(values)) config = config.replaceAll(token, value);

await mkdir(appDir, { recursive: true });
await writeFile(resolve(appDir, `wrangler.generated-${environment}.json`), config);
console.log(`Generated Aleph-OCR ${environment} Wrangler config.`);
