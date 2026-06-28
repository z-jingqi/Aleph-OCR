# Aleph Tools Deployment

This guide is for deploying the Gateway Worker and wiring it to D1, R2, Queues, Workflows, and the Python tools engine.

Use separate Cloudflare resources for `dev` and `prod`. The generated Wrangler config names the Workers `aleph-tools-gateway-dev` and `aleph-tools-gateway-prod`.

## What Can Be Prepared Before Secrets

These commands do not write secrets or deploy production traffic:

```bash
pnpm install
pnpm build
pnpm test
pnpm deploy:check:dev
pnpm deploy:check:prod
pnpm deploy:check:ci:dev
pnpm deploy:check:ci:prod
```

`deploy:check:*` verifies only local environment variables. It does not call Cloudflare.

Before deploying to dev, run the local checks in [Local Testing](./local-testing.md), including the `linux/amd64` tools container E2E path.

## Resource Layout

Recommended names:

| Environment | D1 | R2 | Queue | Worker | Domain |
| --- | --- | --- | --- | --- | --- |
| dev | `aleph-tools-dev` | `aleph-tools-assets-dev` | `aleph-tools-jobs-dev` | `aleph-tools-gateway-dev` | `dev-tools.aleph-cat.com` |
| prod | `aleph-tools-prod` | `aleph-tools-assets-prod` | `aleph-tools-jobs-prod` | `aleph-tools-gateway-prod` | `tools.aleph-cat.com` |

Create resources:

```bash
pnpm --dir apps/gateway exec wrangler d1 create aleph-tools-dev
pnpm --dir apps/gateway exec wrangler r2 bucket create aleph-tools-assets-dev
pnpm --dir apps/gateway exec wrangler queues create aleph-tools-jobs-dev

pnpm --dir apps/gateway exec wrangler d1 create aleph-tools-prod
pnpm --dir apps/gateway exec wrangler r2 bucket create aleph-tools-assets-prod
pnpm --dir apps/gateway exec wrangler queues create aleph-tools-jobs-prod
```

Copy the D1 database ids from the `wrangler d1 create` output.

## Required Settings

Set these locally when generating configs:

```bash
export ALEPH_TOOLS_D1_DATABASE_ID_DEV="<dev-d1-id>"

export ALEPH_TOOLS_D1_DATABASE_ID_PROD="<prod-d1-id>"
export ALEPH_TOOLS_CONTAINER_IMAGE="<container-image>"
```

Optional overrides:

```bash
export ALEPH_TOOLS_R2_BUCKET_DEV="aleph-tools-assets-dev"
export ALEPH_TOOLS_QUEUE_DEV="aleph-tools-jobs-dev"
export ALEPH_TOOLS_DOMAIN_DEV="dev-tools.aleph-cat.com"

export ALEPH_TOOLS_R2_BUCKET_PROD="aleph-tools-assets-prod"
export ALEPH_TOOLS_QUEUE_PROD="aleph-tools-jobs-prod"
export ALEPH_TOOLS_DOMAIN_PROD="tools.aleph-cat.com"
```

The Gateway invokes the Python tools engine through an internal Cloudflare Container Durable Object binding. The engine must not be assigned a public route or custom domain. `ALEPH_TOOLS_ENGINE_URL_DEV/PROD` are not part of the Cloudflare deployment path. Local development still uses `apps/gateway/wrangler.local.jsonc` to reach `http://127.0.0.1:8090`.

## Tools Container Model Cache

The production container image should be built for `linux/amd64` and include predownloaded PaddleOCR models. Runtime requests should not be responsible for model resolution or download.

Set the PaddleX model-source flag in the image build environment. `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True` disables the runtime model source connectivity check.

```bash
cd apps/ocr-container
PADDLEOCR_HOME=/models/paddleocr PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True scripts/download-models.sh
```

Build local and production OCR images with an explicit platform:

```bash
docker build --platform linux/amd64 -t aleph-tools-container:amd64-test apps/ocr-container
```

Before promoting an image, run the local benchmark inside the same image or machine class and confirm that the model cache is present and default `small` fixtures do not fall back unexpectedly. See [OCR Performance Benchmarking](./benchmark/ocr-performance.md) for the benchmark command, cold/warm interpretation, modes, fallback semantics, and performance acceptance gates.

## Worker Secrets

Set these for each generated config:

```bash
pnpm deploy:generate:dev
pnpm --dir apps/gateway exec wrangler secret put ALEPH_TOOLS_API_KEYS --config wrangler.generated-dev.json
pnpm --dir apps/gateway exec wrangler secret put WEBHOOK_SIGNING_SECRET --config wrangler.generated-dev.json
pnpm --dir apps/gateway exec wrangler secret put TOOLS_ENGINE_TOKEN --config wrangler.generated-dev.json

pnpm deploy:generate:prod
pnpm --dir apps/gateway exec wrangler secret put ALEPH_TOOLS_API_KEYS --config wrangler.generated-prod.json
pnpm --dir apps/gateway exec wrangler secret put WEBHOOK_SIGNING_SECRET --config wrangler.generated-prod.json
pnpm --dir apps/gateway exec wrangler secret put TOOLS_ENGINE_TOKEN --config wrangler.generated-prod.json
```

`TOOLS_ENGINE_TOKEN` is optional if the tools engine does not enforce internal auth. `ALEPH_TOOLS_API_KEYS` should be a JSON object:

```json
{"example-client-dev":"replace-with-random-token"}
```

## Deploy Flow

Dev:

```bash
pnpm deploy:check:dev
pnpm deploy:dry-run:dev
pnpm deploy:migrate:dev
pnpm deploy:dev
```

Prod:

```bash
pnpm deploy:check:prod
pnpm deploy:dry-run:prod
pnpm deploy:migrate:prod
pnpm deploy:prod
```

Do not deploy prod before dev has passed smoke tests.

`deploy:dry-run:*` passes `--containers-rollout=none`, so it validates the Worker and bindings without building or publishing the container image. Real `deploy:*` commands still require Docker or a compatible container build environment when `ALEPH_TOOLS_CONTAINER_IMAGE` points at a Dockerfile.

## GitHub Actions

Required GitHub secrets or environment variables:

| Name | Scope | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Deploy and manage Worker resources from CI. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Cloudflare account id for Wrangler. |
| `ALEPH_TOOLS_D1_DATABASE_ID_DEV` | variable or secret | Dev D1 id. |
| `ALEPH_TOOLS_D1_DATABASE_ID_PROD` | variable or secret | Prod D1 id. |
| `ALEPH_TOOLS_CONTAINER_IMAGE` | variable or secret | Required. Enables internal Cloudflare Container invocation. |
| `ALEPH_TOOLS_API_KEYS` | secret | Worker API keys JSON. |
| `WEBHOOK_SIGNING_SECRET` | secret | HMAC secret for webhook signatures. |
| `TOOLS_ENGINE_TOKEN` | secret | Optional internal engine auth token. |

The current workflow deploys the Gateway Worker. Build and publishing of the Python engine container image should be handled by your container pipeline, then configured with `ALEPH_TOOLS_CONTAINER_IMAGE`.

## Smoke Tests

Replace `BASE_URL` and `API_KEY` with the deployed environment values.

```bash
export BASE_URL="https://dev-tools.aleph-cat.com"
export API_KEY="<client-api-key>"

curl -i "$BASE_URL/health"
```

Create an async image conversion job:

```bash
curl -sS -X POST "$BASE_URL/v1/tools/image/convert" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: smoke-image-convert-001" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "targetFormat=webp" \
  -F "width=800"
```

Check status and result:

```bash
curl -sS "$BASE_URL/v1/jobs/<job-id>" -H "Authorization: Bearer $API_KEY"
curl -i "$BASE_URL/v1/jobs/<job-id>/result" -H "Authorization: Bearer $API_KEY"
curl -L "$BASE_URL/v1/jobs/<job-id>/output" -H "Authorization: Bearer $API_KEY" -o smoke.webp
```

SSE recovery check:

```bash
curl -N "$BASE_URL/v1/jobs/<job-id>/events" -H "Authorization: Bearer $API_KEY"
```

OCR smoke test:

```bash
curl -sS -X POST "$BASE_URL/v1/tools/ocr" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: smoke-ocr-001" \
  -F "file=@apps/gateway/test/fixtures/pdfs/receipt-single-page.pdf" \
  -F "ocrMode=small"
```

Image compression smoke test:

```bash
curl -sS -X POST "$BASE_URL/v1/tools/image/compress" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: smoke-image-compress-001" \
  -F "file=@apps/gateway/test/fixtures/images/receipt.png" \
  -F "outputFormat=jpeg" \
  -F "maxWidth=700" \
  -F "targetSizeBytes=70000"
```

## Rollback

For Worker code rollback:

```bash
pnpm --dir apps/gateway exec wrangler versions list --config wrangler.generated-prod.json
pnpm --dir apps/gateway exec wrangler rollback --config wrangler.generated-prod.json
```

This branch uses a clean `tool_jobs` schema and does not migrate legacy OCR tables. Create fresh dev/prod D1 databases or reset the existing databases before deployment. If a deployment needs to be backed out, roll back Worker code and restore the matching D1 snapshot for that release.

## Production Notes

- Keep dev and prod API keys separate.
- Use `Idempotency-Key` for all job creation retries.
- Treat `data.status`, `data.terminal`, `data.resultAvailable`, `data.outputAvailable`, and `error.code` as the external integration contract.
- Webhook delivery failure never rolls back a completed job. Use the delivery retry path and the polling fallback endpoints for recovery.
- The production target is PDFs up to 100 pages and single-image conversion jobs.
- OCR container images should be promoted only after an amd64 image completes image and PDF OCR smoke tests with predownloaded PP-OCRv6 models.
