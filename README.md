# Aleph-OCR

Aleph-OCR is a shared OCR service for Aleph projects. It exposes a Cloudflare Worker gateway with project API-key authentication, stores OCR jobs durably in D1/R2/Queues, and delegates OCR work to a Python FastAPI engine running PaddleOCR.

## Architecture

```text
Client project
  -> Gateway Worker (Hono, auth, validation, job status)
    -> OCR Container (FastAPI, PaddleOCR, PyMuPDF)
      -> OCR JSON / Markdown / plain text
```

The gateway is intentionally generic: it knows about OCR documents, clients, jobs, files, and results; it does not contain project-specific concepts from any consuming app.

## Requirements

- Node.js >= 20
- pnpm >= 9
- Python 3.11+
- Docker, if building the OCR container image

## Install

```bash
pnpm install
```

For the OCR container:

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

## Local Development

Start the OCR container first:

```bash
pnpm --filter @aleph-ocr/ocr-container dev
```

Start the Worker gateway:

```bash
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars
pnpm --filter @aleph-ocr/gateway d1:migrate:local
pnpm --filter @aleph-ocr/gateway dev
```

Default local API key from the example file is `dev-key`.

## Cloudflare Production

Create one set of resources per environment:

```bash
wrangler d1 create aleph-ocr-dev
wrangler r2 bucket create aleph-ocr-assets-dev
wrangler queues create aleph-ocr-jobs-dev
```

Required GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ALEPH_OCR_D1_DATABASE_ID_DEV`
- `ALEPH_OCR_D1_DATABASE_ID_PROD`
- `ALEPH_OCR_ENGINE_URL_DEV`
- `ALEPH_OCR_ENGINE_URL_PROD`
- `ALEPH_OCR_CONTAINER_IMAGE`, when deploying the OCR engine through Cloudflare Containers

Required Worker secrets:

- `ALEPH_OCR_API_KEYS`, for example `{"example-client-dev":"...","example-client-prod":"..."}`
- `WEBHOOK_SIGNING_SECRET`, used to sign async job webhook deliveries
- optional `OCR_ENGINE_TOKEN`, if the engine requires the internal token

Default custom domains:

- dev: `ocr.dev.aleph-cat.com`
- prod: `ocr.aleph-cat.com`

OCR source files and JSON results expire after 7 days by default. A scheduled Worker cleanup marks expired jobs deleted and removes their R2 objects.

Production async jobs are orchestrated through Cloudflare Workflows. Queue messages remain small references only, and PDF OCR runs page by page so a single queue invocation does not need to hold a long-running 100-page job open. Container disk is treated as ephemeral; source files, page results, final results, progress snapshots, and events are persisted to R2/D1.

## Example

```bash
curl -X POST http://127.0.0.1:8787/v1/ocr/sync   -H 'Authorization: Bearer dev-key'   -F 'file=@sample.png'
```

For PDFs, create an async job:

```bash
curl -X POST http://127.0.0.1:8787/v1/jobs   -H 'Authorization: Bearer dev-key'   -F 'file=@sample.pdf'
```

Async jobs can include `callbackUrl` and `metadata` multipart fields for webhook notifications. Use `Idempotency-Key` when retrying a create request. Control panels can subscribe to `GET /v1/jobs/:jobId/events` for SSE progress events, and callers can cancel work with `POST /v1/jobs/:jobId/cancel`.

## Scripts

- `pnpm build` - Type-check/build all packages.
- `pnpm lint` - Run non-mutating checks.
- `pnpm test` - Run gateway unit tests and container syntax checks.
- `pnpm clean` - Remove build outputs.
- `pnpm --filter @aleph-ocr/gateway d1:migrate:local` - Apply local D1 migrations.
- `pnpm --filter @aleph-ocr/gateway dev` - Run Worker locally.
- `pnpm --filter @aleph-ocr/ocr-container dev` - Run FastAPI locally.
