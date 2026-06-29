# API

All `/v1/*` routes require:

```http
Authorization: Bearer <api-key>
```

API keys are configured as the `ALEPH_TOOLS_API_KEYS` Worker secret. A JSON object maps client IDs to keys, for example `{"example-client-preview":"..."}`. Jobs and results are isolated by client ID.

For production client behavior, stable error codes, retry guidance, SSE reconnects, and webhook verification, see [External App Integration](./external-app-integration.md).

## GET /health

Public gateway health check.

## GET /v1/engines

Returns the configured tools engine and capabilities.

The OCR engine container is not public API. External applications must call these Gateway routes only; `/internal/*` routes are private implementation details.

## POST /v1/tools/image/pipeline

Creates one async image pipeline job. This is the production image OCR entrypoint.

By default the pipeline performs necessary conversion, OCR-friendly image compression, then OCR. Conversion is skipped when the uploaded image is already OCR-native (`jpeg`, `jpg`, `png`, `tiff`, `tif`, or `bmp`). Compression can be disabled per request.

Multipart fields:

- `file`: image upload. WebP, HEIC, and HEIF are accepted only when conversion is enabled.
- `pipeline`: optional JSON object string. Defaults are shown below:

```json
{
  "convert": { "enabled": true, "targetFormat": "jpeg", "fit": "inside" },
  "compress": { "enabled": true, "outputFormat": "jpeg", "targetSizeBytes": 350000, "maxWidth": 1000, "maxHeight": 1000, "minQuality": 45, "maxQuality": 75 },
  "ocr": { "ocrMode": "small" }
}
```

For HEIC/HEIF and large phone-photo uploads, the Gateway applies a separate phone-photo default unless the caller overrides the relevant fields: `targetSizeBytes=350000`, `maxWidth=1200`, `maxHeight=1200`, and `maxQuality=72`. The OCR engine also applies an internal temporary max-side guard and light document crop for pipeline jobs; this does not change the standalone image compression tool output.

- `callbackUrl`: optional HTTPS webhook URL for `ready`, `failed`, and `cancelled` notifications.
- `metadata`: optional JSON object string echoed back in webhook payloads.

Required header:

- `Idempotency-Key`: scoped to the authenticated client. Reusing the same key returns the original job.

`GET /v1/jobs/:jobId/result` returns `tool: "image.pipeline"` with `converted.status`, `compressed.status`, final `output`, `ocr`, and pipeline `timingsMs` fields. `GET /v1/jobs/:jobId/output` downloads the final image used for OCR.

## POST /v1/tools/ocr/sync

Synchronous image OCR. Disabled by default in production; set `ENABLE_SYNC_ENDPOINTS=true` only for local/debug environments. Multipart form field:

- `file`: JPEG, PNG, TIFF, or BMP image.
- `ocrMode`: optional `tiny`, `small`, or `medium`; defaults to `small`.

Limits:

- Image only.
- Max 10 MB.

## POST /v1/tools/image/convert/sync

Synchronous image conversion. Disabled by default in production; set `ENABLE_SYNC_ENDPOINTS=true` only for local/debug environments. Multipart form fields:

- `file`: image accepted by the conversion engine.
- `targetFormat`: `png`, `jpeg`, `webp`, or `avif`.
- `quality`: optional integer from 1 to 100.
- `width` and `height`: optional positive integers.
- `fit`: optional `contain`, `cover`, or `inside`; defaults to `inside`.

Returns the converted binary image directly. `Content-Type` matches the target format and `Content-Disposition` includes the converted filename. Max upload size is 10 MB.

## POST /v1/tools/ocr

Creates an OCR job. Multipart form field:

- `file`: PDF, JPEG, PNG, TIFF, or BMP. Use `/v1/tools/image/pipeline` for WebP, HEIC, or HEIF image OCR.
- `ocrMode`: optional `tiny`, `small`, or `medium`; defaults to `small`.
- `pdfExtractionMode`: optional `auto`, `text`, or `ocr`; defaults to `auto` and only applies to PDFs.
- `callbackUrl`: optional HTTPS webhook URL for `ready`, `failed`, and `cancelled` notifications.
- `metadata`: optional JSON object string echoed back in webhook payloads.

Optional header:

- `Idempotency-Key`: scoped to the authenticated client. Reusing the same key returns the original job instead of creating another job.

OCR-native images and PDFs are accepted. PDFs are always async and are processed page by page. The production target is 100 pages or fewer.

PDF extraction modes:

- `auto`: default. Each page is inspected for an embedded text layer. Pages with usable text are extracted directly with PyMuPDF; scanned pages continue through PP-OCRv6. Mixed PDFs are supported.
- `text`: requires every page to have usable embedded text. If any page has no usable text layer, the job fails instead of silently running OCR.
- `ocr`: skips embedded text extraction and runs PP-OCRv6 for every page.

For PDFs, ready OCR results include:

- Top-level `extractionMethod`: `pdf_text`, `ocr`, or `mixed`.
- Per-page `extractionMethod`: `pdf_text` or `ocr`.
- `metadata.pdfExtractionMode` and `metadata.extractionMethod`.
- `timingsMs.extractText` when embedded text was extracted.

Embedded text extraction is a speed optimization, not table or document understanding. `tables` remains an empty array unless a future structured-document tool is added.

## POST /v1/tools/image/convert

Creates an async image conversion job. Use this when the caller needs image conversion without OCR.

Async conversion results are stored in R2. `GET /v1/jobs/:jobId/result` returns metadata and `GET /v1/jobs/:jobId/output` downloads the converted binary file.

## POST /v1/tools/image/compress/sync

Synchronous image compression. Disabled by default in production; set `ENABLE_SYNC_ENDPOINTS=true` only for local/debug environments. Multipart form fields:

- `file`: image accepted by the compression engine.
- `targetSizeBytes`: optional positive integer target.
- `maxWidth` and `maxHeight`: optional positive integers; aspect ratio is preserved.
- `minQuality` and `maxQuality`: optional integers from 1 to 100; defaults to 45 and 85.
- `outputFormat`: optional `jpeg` or `webp`; defaults to `jpeg`.

Returns the compressed binary image directly. Compression does not trigger OCR.

## POST /v1/tools/image/compress

Creates an async image compression job. Use this when the caller needs compression without OCR.

Async compression results are stored in R2. `GET /v1/jobs/:jobId/result` returns compression metadata and `GET /v1/jobs/:jobId/output` downloads the compressed binary file.

## GET /v1/jobs/:jobId

Returns job metadata and status. Status values:

- `queued`
- `processing`
- `cancel_requested`
- `cancelled`
- `ready`
- `failed`
- `deleted`

The returned job also includes progress snapshot fields:

- `progress`: integer from 0 to 100.
- `stage`: coarse processing stage, such as `queued`, `processing`, `ocr`, `ready`, or `failed`.
- `currentPage` and `totalPages`: present when known.
- `expiresAt`: when source/result objects are eligible for cleanup.
- `completedAt`: present for terminal states.

Only the client that created a job can read, delete, or fetch its result.

## GET /v1/jobs/:jobId/events

Streams job snapshots and events as `text/event-stream`. The route uses the same API-key ownership rules as job reads.

The stream sends:

- `job.snapshot`: current persisted job state when the connection opens.
- `job.created`, `job.status`, `job.progress`, `job.page.ready`, `job.ready`, `job.failed`, `job.cancel_requested`, `job.cancelled`, or `job.deleted`: stored job events.
- `ping`: heartbeat events while the connection is open.

Clients can reconnect with `Last-Event-ID` to receive events after the last seen sequence number. If the job is already terminal, clients should still call `GET /v1/jobs/:jobId` and `GET /v1/jobs/:jobId/result` as the source of truth.

## GET /v1/jobs/:jobId/result

Returns the complete OCR result once ready, image output metadata for `tool: "image.convert"` and `tool: "image.compress"` jobs, or pipeline metadata for `tool: "image.pipeline"` jobs.

If the job is `queued`, `processing`, or `cancel_requested`, this returns `409`. Cancelled, failed, deleted, and missing result states return an error instead of a partial result.

## GET /v1/jobs/:jobId/output

Downloads a ready job's binary output. This is used by `image.convert`, `image.compress`, and `image.pipeline` jobs. Non-ready jobs return `409`.

## POST /v1/jobs/:jobId/cancel

Requests cancellation. Queued jobs become `cancelled` immediately. Processing jobs first become `cancel_requested`; the workflow checks this state between image/page steps and then marks the job `cancelled`. A cancelled job never transitions to `ready`.

## DELETE /v1/jobs/:jobId

Marks a job deleted and removes source, result, page result, and output objects.

## Webhooks

When `callbackUrl` is provided, the gateway posts a JSON notification after a job becomes `ready`, `failed`, or `cancelled`.

Headers:

- `X-Aleph-Tools-Event-Id`: stable event ID.
- `X-Aleph-Tools-Delivery-Id`: delivery attempt ID.
- `X-Aleph-Tools-Timestamp`: signing timestamp.
- `X-Aleph-Tools-Signature`: `sha256=<hex hmac>` over `<timestamp>.<raw body>` using the receiving client's secret from `ALEPH_TOOLS_WEBHOOK_SECRETS`.

Ready payloads include `event`, `eventId`, `jobId`, `job`, `resultUrl`, `metadata`, and `createdAt`. Image output and pipeline jobs also include `outputUrl`. Failed payloads include `event`, `eventId`, `jobId`, `job`, `error`, `metadata`, and `createdAt`. Cancelled payloads include `event`, `eventId`, `jobId`, `job`, `metadata`, and `createdAt`.
