# Aleph Tools

Aleph Tools is an authenticated OCR Gateway for Aleph applications. The current service version supports image OCR only:

```text
Client app
  -> Cloudflare Worker Gateway
      -> D1 job state and events
      -> R2 source/result storage
      -> Cloudflare Images for required image conversion
      -> Google Vision DOCUMENT_TEXT_DETECTION
      -> SSE/Webhook notifications
```

## Current Scope

- Supported: image OCR for `jpeg`, `png`, `gif`, `webp`, `bmp`, and `tiff`.
- Auto-converted before OCR: `heic`, `heif`, and `avif`, converted to JPEG through Cloudflare Images.
- Not supported in this version: PDF OCR, image compression, standalone image conversion tools, local OCR models, and container OCR runtime.

## API

All `/v1/*` routes require:

```http
Authorization: Bearer <api-key>
```

Create an async OCR job:

```bash
curl -X POST https://preview-tools.aleph-cat.com/v1/tools/ocr \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY" \
  -H "Idempotency-Key: receipt-001" \
  -F "file=@receipt.heic" \
  -F 'metadata={"documentId":"doc_123"}' \
  -F "callbackUrl=https://app.example.com/webhooks/aleph-tools"
```

Read status:

```bash
curl https://preview-tools.aleph-cat.com/v1/jobs/<jobId> \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Read result when `resultAvailable` is true:

```bash
curl https://preview-tools.aleph-cat.com/v1/jobs/<jobId>/result \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Local/debug sync OCR is available only when `ENABLE_SYNC_ENDPOINTS=true`:

```bash
curl -X POST http://127.0.0.1:8787/v1/tools/ocr/sync \
  -H "Authorization: Bearer dev-key" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png"
```

## Configuration

Required Worker secrets:

- `ALEPH_TOOLS_API_KEYS`: JSON object mapping `clientId` to API key.
- `ALEPH_TOOLS_WEBHOOK_SECRETS`: JSON object mapping `clientId` to webhook HMAC secret.
- `GOOGLE_VISION_CREDENTIALS_JSON`: Google service account JSON with Vision API access. `GOOGLE_VISION_API_KEY` is supported for local smoke tests.

Required bindings:

- D1: `DB`
- R2: `ASSETS`
- Queue: `TOOLS_JOBS`
- Workflow: `TOOLS_WORKFLOW`
- Cloudflare Images: `IMAGES`

## Local Development

```bash
pnpm install
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars
# Set GOOGLE_VISION_CREDENTIALS_JSON or GOOGLE_VISION_API_KEY in apps/gateway/.dev.vars
pnpm dev:local
```

The local script starts only the Gateway. There is no local OCR container.

## Validation

```bash
pnpm build
pnpm test
git diff --check
```

See [docs/api.md](docs/api.md), [docs/deployment.md](docs/deployment.md), and [docs/external-app-integration.md](docs/external-app-integration.md).
