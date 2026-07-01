# Aleph Tools

Aleph Tools is an authenticated OCR Gateway for Aleph applications. The current service version supports image OCR only:

```text
Service-bound Worker
  -> Aleph Tools Worker Gateway
      -> D1 job state and events
      -> R2 source/result storage
      -> Cloudflare Images for required image conversion
      -> Google Vision DOCUMENT_TEXT_DETECTION
      -> SSE/Webhook notifications
```

## Current Scope

- Supported: image OCR for `jpeg`, `png`, `gif`, `webp`, `bmp`, `tiff`, `raw`, and `dng`.
- Auto-converted before OCR: `heic` and `heif`, converted to JPEG through Cloudflare Images.
- Not supported in this version: PDF OCR, AVIF input, image compression, standalone image conversion tools, local OCR models, and container OCR runtime.

## Service Binding API

Production deployments are service-binding only: no public route and no `workers.dev` URL. Calling Workers bind to the deployed Aleph Tools Worker and call the same `/v1/*` paths with `env.ALEPH_OCR.fetch(...)`.

All `/v1/*` requests still require:

```http
Authorization: Bearer <api-key>
```

Create an async OCR job from a calling Worker:

```ts
await env.ALEPH_OCR.fetch('https://aleph-ocr.internal/v1/tools/ocr', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.ALEPH_TOOLS_API_KEY}`,
    'Idempotency-Key': 'receipt-001',
  },
  body: formData,
});
```

Source images are retained for at most 3 days and are unavailable after the job is deleted or expires. Aleph Tools does not provide a thumbnail endpoint; external applications should generate/store their own thumbnails if needed.

See [docs/service-binding.md](docs/service-binding.md) for complete calling Worker examples.

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

See [docs/api.md](docs/api.md), [docs/deployment.md](docs/deployment.md), [docs/external-app-integration.md](docs/external-app-integration.md), and [docs/service-binding.md](docs/service-binding.md).
