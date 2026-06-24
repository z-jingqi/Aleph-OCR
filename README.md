# Aleph-OCR

Aleph-OCR is a shared OCR service for Aleph projects. It exposes a Cloudflare Worker gateway with project API-key authentication and delegates OCR work to a Python FastAPI container running PaddleOCR locally.

## Architecture

```text
Client project
  -> Gateway Worker (Hono, auth, validation, job status)
    -> OCR Container (FastAPI, PaddleOCR, PyMuPDF)
      -> OCR JSON / Markdown / plain text
```

The first prototype keeps job state in Worker memory so the API can be exercised locally. Production deployment should replace the memory store with D1/R2/Queue bindings already reserved in `apps/gateway/wrangler.toml`.

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
python3 -m venv .venv
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
pnpm --filter @aleph-ocr/gateway dev
```

Default local API key from the example file is `dev-key`.

## Example

```bash
curl -X POST http://127.0.0.1:8787/v1/ocr/sync   -H 'Authorization: Bearer dev-key'   -F 'file=@sample.png'
```

For PDFs, create an async job:

```bash
curl -X POST http://127.0.0.1:8787/v1/jobs   -H 'Authorization: Bearer dev-key'   -F 'file=@sample.pdf'
```

## Scripts

- `pnpm build` - Type-check/build all packages.
- `pnpm lint` - Run non-mutating checks.
- `pnpm clean` - Remove build outputs.
- `pnpm --filter @aleph-ocr/gateway dev` - Run Worker locally.
- `pnpm --filter @aleph-ocr/ocr-container dev` - Run FastAPI locally.
