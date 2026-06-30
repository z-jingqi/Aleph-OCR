# Local Testing

## Setup

```bash
pnpm install
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars
```

Set one Google Vision credential in `apps/gateway/.dev.vars`:

```text
GOOGLE_VISION_CREDENTIALS_JSON=<service-account-json>
```

or for local smoke testing:

```text
GOOGLE_VISION_API_KEY=<api-key>
```

## Start

```bash
pnpm dev:local
```

The script applies local D1 migrations and starts Wrangler. It does not start Docker or any OCR container.

## API Smoke

```bash
curl http://127.0.0.1:8787/health

curl -X POST http://127.0.0.1:8787/v1/tools/ocr/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png"
```

HEIC conversion smoke:

```bash
curl -X POST http://127.0.0.1:8787/v1/tools/ocr/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/IMG_4706.HEIC"
```

Async smoke:

```bash
curl -X POST http://127.0.0.1:8787/v1/tools/ocr \
  -H "Authorization: Bearer dev-key" \
  -H "Idempotency-Key: local-smoke-1" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png"
```

Then read:

```bash
curl http://127.0.0.1:8787/v1/jobs/<jobId> \
  -H "Authorization: Bearer dev-key"
```

## Automated Checks

```bash
pnpm build
pnpm test
git diff --check
```

If dependency installation is required in a restricted environment, run the checks after network access is available.
