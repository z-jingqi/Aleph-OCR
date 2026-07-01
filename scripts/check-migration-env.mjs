const [environment] = process.argv.slice(2);

if (!environment || !['preview', 'prod'].includes(environment)) {
  console.error('Usage: node scripts/check-migration-env.mjs <preview|prod>');
  process.exit(1);
}

const checks = [
  {
    label: 'Cloudflare API token',
    names: ['CLOUDFLARE_API_TOKEN'],
    note: 'Required for GitHub Actions migrations. Local migrations can use wrangler login.',
  },
  {
    label: 'Cloudflare account id',
    names: ['CLOUDFLARE_ACCOUNT_ID'],
    note: 'Required for GitHub Actions migrations.',
  },
];

const runningInCi = Boolean(process.env.CI);

const rows = checks.map((check) => {
  const matched = check.names.find((name) => Boolean(process.env[name]));
  return {
    ...check,
    matched,
    status: matched ? 'ok' : runningInCi ? 'missing' : 'local-login-ok',
  };
});

const missing = runningInCi ? rows.filter((row) => !row.matched) : [];

console.log(`Aleph Tools migration environment check: ${environment}${runningInCi ? ' (ci)' : ''}`);
for (const row of rows) {
  const names = row.names.join(' or ');
  const source = row.matched ? `found ${row.matched}` : row.note;
  console.log(`- ${row.status.padEnd(16)} ${row.label}: ${names} - ${source}`);
}

if (missing.length > 0) {
  console.error(`\nMissing ${missing.length} required migration setting(s).`);
  process.exit(1);
}

console.log('\nMigration settings are sufficient.');
