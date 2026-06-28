# Local Testing

This runbook covers the checks to run before deploying Aleph Tools to the Cloudflare dev environment.

## Baseline Checks

Run these from the repository root:

```bash
CI=true pnpm install --frozen-lockfile --offline
CI=true pnpm build
CI=true pnpm exec turbo run test --force
CI=true pnpm --dir apps/gateway d1:migrate:local
git --no-optional-locks diff --check
```

Confirm no removed OCR v5 compatibility remains:

```bash
rg -n "PP-OCRv5|\\bfast\\b|\\bbalanced\\b|\\baccurate\\b|ocrModes|defaultOcrMode|modeConfigs|X-Aleph-OCR|OcrJobWorkflow|ocr_engine|/v1/ocr/sync|ocr_jobs|ocr_job_events|ocr_webhook" apps packages README.md scripts docs/api.md docs/architecture.md docs/deployment.md docs/external-app-integration.md
```

The `rg` command should return no matches.

## Docker Platform

Use `linux/amd64` for local OCR E2E tests and for production container images. PaddleOCR 3.7.0 with PaddlePaddle 3.2.2 can initialize PP-OCRv6 models on local Apple Silicon arm64 containers, but OCR inference can crash in the Paddle C++ predictor path. The same code, dependencies, fixtures, and PP-OCRv6 model cache have been verified with a `linux/amd64` image.

Build the local OCR-capable image:

```bash
ENGINE_IMAGE=aleph-tools-container:amd64-test \
ENGINE_PLATFORM=linux/amd64 \
REBUILD_IMAGE=1 \
APPLY_MIGRATIONS=0 \
pnpm dev:local
```

After the first successful build, reuse the image:

```bash
ENGINE_IMAGE=aleph-tools-container:amd64-test \
ENGINE_PLATFORM=linux/amd64 \
APPLY_MIGRATIONS=0 \
pnpm dev:local
```

The local gateway runs at `http://127.0.0.1:8787`. Use:

```http
Authorization: Bearer dev-key
```

## Smoke Requests

Health and engine info:

```bash
curl -sS http://127.0.0.1:8787/health
curl -sS http://127.0.0.1:8787/v1/engines -H "Authorization: Bearer dev-key"
```

Old create routes should stay removed:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/ocr/sync -H "Authorization: Bearer dev-key"
curl -i -X POST http://127.0.0.1:8787/v1/jobs -H "Authorization: Bearer dev-key"
```

Both should return `404`.

Synchronous tools:

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/tools/image/compress/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "outputFormat=webp" \
  -F "maxWidth=600" \
  -F "targetSizeBytes=50000" \
  -o /tmp/aleph-compress.webp

curl -sS -X POST http://127.0.0.1:8787/v1/tools/image/convert/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "targetFormat=webp" \
  -F "width=600" \
  -o /tmp/aleph-convert.webp

curl -sS -X POST http://127.0.0.1:8787/v1/tools/ocr/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "ocrMode=small"
```

Async tools:

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/tools/image/compress \
  -H "Authorization: Bearer dev-key" \
  -H "Idempotency-Key: local-compress-001" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "outputFormat=jpeg" \
  -F "maxWidth=700" \
  -F "targetSizeBytes=70000"

curl -sS -X POST http://127.0.0.1:8787/v1/tools/image/convert \
  -H "Authorization: Bearer dev-key" \
  -H "Idempotency-Key: local-convert-001" \
  -F "file=@apps/gateway/test/fixtures/images/invoice-table.png" \
  -F "targetFormat=webp" \
  -F "width=800"

curl -sS -X POST http://127.0.0.1:8787/v1/tools/ocr \
  -H "Authorization: Bearer dev-key" \
  -H "Idempotency-Key: local-ocr-pdf-001" \
  -F "file=@apps/gateway/test/fixtures/pdfs/receipt-single-page.pdf" \
  -F "ocrMode=small"
```

For each returned job id, verify:

```bash
curl -sS http://127.0.0.1:8787/v1/jobs/<job-id> -H "Authorization: Bearer dev-key"
curl -i http://127.0.0.1:8787/v1/jobs/<job-id>/result -H "Authorization: Bearer dev-key"
curl -N http://127.0.0.1:8787/v1/jobs/<job-id>/events -H "Authorization: Bearer dev-key"
```

For `image.convert` and `image.compress`, also verify:

```bash
curl -L http://127.0.0.1:8787/v1/jobs/<job-id>/output \
  -H "Authorization: Bearer dev-key" \
  -o /tmp/aleph-output.bin
```

Expected behavior:

- `queued`, `processing`, and `cancel_requested` result reads return `409 JOB_NOT_READY`.
- Ready OCR jobs expose `plainText`, `pages`, `ocrMode`, `requestedOcrMode`, `fallbackUsed`, `quality`, and `timingsMs`.
- Ready image output jobs expose metadata from `/result` and binary output from `/output`.
- SSE opens as `text/event-stream` and starts with `job.snapshot`.
- Cancelling a queued job returns `cancelled`.

## Benchmark

Run direct OCR benchmark only against an image with predownloaded PP-OCRv6 models:

```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD/apps/gateway/test/fixtures:/fixtures:ro" \
  aleph-tools-container:amd64-test \
  python -c "from src.ocr import ocr_image_bytes; from pathlib import Path; p=Path('/fixtures/images/receipt.png'); r=ocr_image_bytes(p.read_bytes(), p.name, 'image/png', mode='small'); print(r['plainText'])"
```

Generated benchmark JSON files are local artifacts and should not be committed.
