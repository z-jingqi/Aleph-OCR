const [environment, ...rawFlags] = process.argv.slice(2);
const flags = rawFlags.filter((flag) => flag !== '--');

if (!environment || !['preview', 'prod'].includes(environment)) {
  console.error('Usage: node scripts/check-deploy-env.mjs <preview|prod> [--ci]');
  process.exit(1);
}

const suffix = environment.toUpperCase();
const strictCi = flags.includes('--ci');

const checks = [
  {
    label: 'D1 database id',
    required: true,
    names: [`ALEPH_TOOLS_D1_DATABASE_ID_${suffix}`],
    note: 'Required to generate the remote Wrangler config.',
  },
  {
    label: 'R2 bucket',
    required: false,
    names: [`ALEPH_TOOLS_R2_BUCKET_${suffix}`],
    note: `Defaults to aleph-tools-assets-${environment}.`,
  },
  {
    label: 'Queue',
    required: false,
    names: [`ALEPH_TOOLS_QUEUE_${suffix}`],
    note: `Defaults to aleph-tools-jobs-${environment}.`,
  },
  {
    label: 'Google Vision credentials',
    required: strictCi,
    names: ['GOOGLE_VISION_CREDENTIALS_JSON', 'GOOGLE_VISION_API_KEY'],
    note: 'Set as a Worker secret. Service account JSON is recommended for production.',
  },
  {
    label: 'API keys secret value',
    required: strictCi,
    names: ['ALEPH_TOOLS_API_KEYS'],
    note: 'Set as a Worker secret with wrangler secret put before manual deploy.',
  },
  {
    label: 'Webhook signing secrets',
    required: strictCi,
    names: ['ALEPH_TOOLS_WEBHOOK_SECRETS'],
    note: 'Required for production webhook verification. JSON object keyed by client id.',
  },
  {
    label: 'Cloudflare API token',
    required: strictCi,
    names: ['CLOUDFLARE_API_TOKEN'],
    note: 'Required for GitHub Actions deploy. Local deploy can use wrangler login.',
  },
  {
    label: 'Cloudflare account id',
    required: strictCi,
    names: ['CLOUDFLARE_ACCOUNT_ID'],
    note: 'Required for GitHub Actions deploy.',
  },
];

const rows = checks.map((check) => {
  const matched = check.names.find((name) => Boolean(process.env[name]));
  const required = check.required ? 'required' : 'optional';
  return {
    ...check,
    matched,
    status: matched ? 'ok' : check.required ? 'missing' : 'default/optional',
    required,
  };
});

const missing = rows.filter((row) => row.required === 'required' && !row.matched);

console.log(`Aleph Tools deploy environment check: ${environment}${strictCi ? ' (ci)' : ''}`);
for (const row of rows) {
  const names = row.names.join(' or ');
  const source = row.matched ? `found ${row.matched}` : row.note;
  console.log(`- ${row.status.padEnd(16)} ${row.label}: ${names} (${row.required}) - ${source}`);
}

if (missing.length > 0) {
  console.error(`\nMissing ${missing.length} required deployment setting(s).`);
  process.exit(1);
}

console.log('\nDeployment settings are sufficient for config generation.');
