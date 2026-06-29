# Aleph Tools

Aleph Tools is a shared tool service for Aleph projects. It exposes a Cloudflare Worker gateway with project API-key authentication, stores async jobs durably in D1/R2/Queues/Workflows, and delegates heavier work to a private Python FastAPI container. The first tools are OCR, image conversion, and image compression.

## Architecture

```text
Client project
  -> Gateway Worker (Hono, auth, validation, job status)
    -> Tools Container (FastAPI, PaddleOCR, PyMuPDF, Pillow)
      -> OCR JSON / Markdown / plain text
      -> converted image binaries
```

The gateway is intentionally generic: it knows about tools, clients, jobs, files, and results; it does not contain project-specific concepts from any consuming app.

## Requirements

- Node.js >= 20
- pnpm >= 9
- Python 3.11+
- Docker, if building the tools container image

## Install

```bash
pnpm install
```

For the tools container:

```bash
cd apps/ocr-container
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

PaddleOCR and PaddlePaddle are heavy dependencies. The first OCR request may download model files unless you prefetch them:

```bash
apps/ocr-container/scripts/download-models.sh
```

For local validation before deployment, see [docs/local-testing.md](docs/local-testing.md). For service-free OCR benchmark guidance, modes, cold/warm interpretation, and performance acceptance gates, see [docs/benchmark/ocr-performance.md](docs/benchmark/ocr-performance.md).

## Local Development

Start the local tools engine container and Worker gateway together:

```bash
pnpm dev:local
```

The script uses `aleph-tools-container:local`, creates `apps/gateway/.dev.vars` if needed, applies local D1 migrations, and starts the gateway on `http://127.0.0.1:8787`. Default local API key from the example file is `dev-key`.

For OCR E2E on Apple Silicon, use the amd64 image path because local arm64 PaddleOCR inference is not reliable:

```bash
ENGINE_IMAGE=aleph-tools-container:amd64-test \
ENGINE_PLATFORM=linux/amd64 \
REBUILD_IMAGE=1 \
APPLY_MIGRATIONS=0 \
pnpm dev:local
```

Force a fresh container image build before startup:

```bash
REBUILD_IMAGE=1 pnpm dev:local
```

Run services separately when debugging a single process:

```bash
pnpm --filter @aleph-tools/tools-container dev
pnpm --filter @aleph-tools/gateway dev
```

## Cloudflare Production

Full deployment runbook: [docs/deployment.md](docs/deployment.md).

Create one set of resources per environment:

```bash
wrangler d1 create aleph-tools-dev
wrangler r2 bucket create aleph-tools-assets-dev
wrangler queues create aleph-tools-jobs-dev
```

Repeat with `prod` names for production:

```bash
wrangler d1 create aleph-tools-prod
wrangler r2 bucket create aleph-tools-assets-prod
wrangler queues create aleph-tools-jobs-prod
```

Required GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ALEPH_TOOLS_D1_DATABASE_ID_DEV`
- `ALEPH_TOOLS_D1_DATABASE_ID_PROD`
- `ALEPH_TOOLS_CONTAINER_IMAGE`, when deploying the tools engine through Cloudflare Containers

Required Worker secrets:

- `ALEPH_TOOLS_API_KEYS`, for example `{"example-client-dev":"...","example-client-prod":"..."}`
- `WEBHOOK_SIGNING_SECRET`, used to sign async job webhook deliveries
- optional `TOOLS_ENGINE_TOKEN`, if the engine requires the internal token

Deployment modes:

- Cloudflare Containers: set `ALEPH_TOOLS_CONTAINER_IMAGE`. The Gateway invokes the engine through an internal container Durable Object binding, so the engine does not need a public URL.
- `ALEPH_TOOLS_ENGINE_URL_DEV/PROD` are not used for Cloudflare deployment. Local development still uses `apps/gateway/wrangler.local.jsonc` to reach `http://127.0.0.1:8090`.

Generate a Wrangler config, apply D1 migrations, and deploy:

```bash
ALEPH_TOOLS_D1_DATABASE_ID_DEV="<d1-id>" \
ALEPH_TOOLS_CONTAINER_IMAGE="<container-image>" \
node scripts/prepare-wrangler-config.mjs dev

pnpm --dir apps/gateway exec wrangler secret put ALEPH_TOOLS_API_KEYS --config wrangler.generated-dev.json
pnpm --dir apps/gateway exec wrangler secret put WEBHOOK_SIGNING_SECRET --config wrangler.generated-dev.json
pnpm --dir apps/gateway exec wrangler d1 migrations apply aleph-tools-dev --remote --config wrangler.generated-dev.json
pnpm --dir apps/gateway exec wrangler deploy --config wrangler.generated-dev.json
```

Default custom domains:

- dev: `dev-tools.aleph-cat.com`
- prod: `tools.aleph-cat.com`

Source files, JSON results, page results, and image tool outputs expire after 7 days by default. A scheduled Worker cleanup marks expired jobs deleted and removes their R2 objects.

Production image pipeline jobs are processed through Cloudflare Queues for backpressure and controlled concurrency. PDF OCR still uses Workflows so long documents can run page by page without Queue wall-time pressure. Container disk is treated as ephemeral; source files, page results, final results, image outputs, progress snapshots, and events are persisted to R2/D1.

The Python OCR engine is an internal Gateway dependency. Production calls it through the Cloudflare Container binding only; external applications must call Gateway routes and must not call `/internal/*` container routes directly.

## Example

Create a production-style image pipeline job:

```bash
curl -X POST http://127.0.0.1:8787/v1/tools/image/pipeline \
  -H 'Authorization: Bearer dev-key' \
  -H 'Idempotency-Key: sample-pipeline-001' \
  -F 'file=@sample.png' \
  -F 'pipeline={"convert":{"targetFormat":"webp","width":1200,"fit":"inside"},"compress":{"outputFormat":"jpeg","maxWidth":1200},"ocr":{"ocrMode":"small"}}'
```

For PDFs, create an async job:

```bash
curl -X POST http://127.0.0.1:8787/v1/tools/ocr \
  -H 'Authorization: Bearer dev-key' \
  -F 'file=@sample.pdf' \
  -F 'ocrMode=small'
```

Async jobs can include `callbackUrl` and `metadata` multipart fields for webhook notifications. Use `Idempotency-Key` when retrying a create request. Control panels can subscribe to `GET /v1/jobs/:jobId/events` for SSE progress events, and callers can cancel work with `POST /v1/jobs/:jobId/cancel`.

For images, use `POST /v1/tools/image/pipeline` with one upload and a JSON `pipeline` field. Once ready, `GET /v1/jobs/:jobId/result` returns conversion metadata, compression metadata, and OCR output; `GET /v1/jobs/:jobId/output` downloads the final compressed image.

## Scripts

- `pnpm build` - Type-check/build all packages.
- `pnpm dev:local` - Start the local tools engine container and Worker gateway together.
- `pnpm lint` - Run non-mutating checks.
- `pnpm test` - Run gateway unit tests and container syntax checks.
- `pnpm clean` - Remove build outputs.
- `pnpm --filter @aleph-tools/tools-container benchmark:ocr` - Run the local OCR fixture benchmark directly against Python engine functions.
- `pnpm deploy:check:dev` / `pnpm deploy:check:prod` - Check required deployment environment variables without calling Cloudflare.
- `pnpm deploy:check:ci:dev` / `pnpm deploy:check:ci:prod` - Strict deployment check including CI and secret values expected by automation.
- `pnpm deploy:dry-run:dev` / `pnpm deploy:dry-run:prod` - Generate config and run Wrangler deploy validation.
- `pnpm deploy:migrate:dev` / `pnpm deploy:migrate:prod` - Apply remote D1 migrations.
- `pnpm deploy:dev` / `pnpm deploy:prod` - Deploy the generated Gateway Worker config.
- `pnpm --filter @aleph-tools/gateway d1:migrate:local` - Apply local D1 migrations.
- `pnpm --filter @aleph-tools/gateway dev` - Run Worker locally.
- `pnpm --filter @aleph-tools/tools-container dev` - Run FastAPI locally.
