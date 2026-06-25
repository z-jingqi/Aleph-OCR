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
const containerImage = process.env.ALEPH_TOOLS_CONTAINER_IMAGE ?? process.env.ALEPH_OCR_CONTAINER_IMAGE ?? '';
const defaultToolsDomain = environment === 'prod' ? 'tools.aleph-cat.com' : 'dev-tools.aleph-cat.com';
const values = {
  __ENV__: environment,
  __TOOLS_DOMAIN__: process.env[`ALEPH_TOOLS_DOMAIN_${suffix}`] ?? defaultToolsDomain,
  __TOOLS_ENGINE_URL__: '',
  __TOOLS_CONTAINER_IMAGE__: containerImage,
  __D1_DATABASE_ID__: process.env[`ALEPH_TOOLS_D1_DATABASE_ID_${suffix}`] ?? process.env[`ALEPH_OCR_D1_DATABASE_ID_${suffix}`] ?? '__D1_DATABASE_ID__',
  __R2_BUCKET__: process.env[`ALEPH_TOOLS_R2_BUCKET_${suffix}`] ?? process.env[`ALEPH_OCR_R2_BUCKET_${suffix}`] ?? `aleph-tools-assets-${environment}`,
  __QUEUE__: process.env[`ALEPH_TOOLS_QUEUE_${suffix}`] ?? process.env[`ALEPH_OCR_QUEUE_${suffix}`] ?? `aleph-tools-jobs-${environment}`,
};

for (const name of ['__D1_DATABASE_ID__']) {
if (values[name] === name) {
    throw new Error(`ALEPH_TOOLS_D1_DATABASE_ID_${suffix} is required.`);
  }
}

if (!values.__TOOLS_CONTAINER_IMAGE__) {
  throw new Error('ALEPH_TOOLS_CONTAINER_IMAGE is required for Cloudflare Container deployment.');
}

let config = await readFile(resolve(appDir, 'wrangler.template.jsonc'), 'utf8');
for (const [token, value] of Object.entries(values)) config = config.replaceAll(token, value);

await mkdir(appDir, { recursive: true });
await writeFile(resolve(appDir, `wrangler.generated-${environment}.json`), config);
console.log(`Generated Aleph Tools ${environment} Wrangler config.`);
