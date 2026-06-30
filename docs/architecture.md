# Architecture

Aleph Tools is currently an image OCR Gateway.

## Components

```text
Business app
  -> Cloudflare Worker Gateway
      -> D1: job snapshots, events, webhook deliveries
      -> R2: source image and OCR result JSON
      -> Queue/Workflow: async job execution
      -> Cloudflare Images: internal format conversion
      -> Google Vision: OCR
```

## OCR Flow

```text
validate image
  -> store source in R2
  -> claim job
  -> load source
  -> convert to JPEG if Google Vision should not receive original format
  -> call Google Vision DOCUMENT_TEXT_DETECTION
  -> normalize result
  -> store JSON result in R2
  -> mark D1 job ready
  -> send webhook if configured
```

The system never exposes Cloudflare Images as a standalone tool. It is an internal pre-OCR conversion step.

## Supported Files

Direct Google Vision OCR:

- `jpeg`
- `png`
- `gif`
- `webp`
- `bmp`
- `tiff`

Internal conversion before OCR:

- `heic`
- `heif`
- `avif`

Unsupported:

- PDF
- SVG
- unknown image formats

## Reliability Rules

- D1 job status is the source of truth.
- R2 result is written before the job becomes `ready`.
- Webhook delivery is independent from OCR success and never rolls back a ready job.
- Queue retry can re-run failed processing, but ready/cancelled/deleted jobs are not reprocessed.
- Cancellation is honored before result storage.

## Removed Components

The current version intentionally removes:

- Local OCR models.
- Container OCR runtime.
- Python OCR service.
- PDF page processing and text-layer extraction.
- Standalone image conversion/compression tools.
- Image pipeline and OCR mode/fallback configuration.
