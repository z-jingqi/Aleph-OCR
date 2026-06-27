# API

All `/v1/*` routes require:

```http
Authorization: Bearer <api-key>
```

API keys are configured as the `ALEPH_TOOLS_API_KEYS` Worker secret. A JSON object maps client IDs to keys, for example `{"example-client-dev":"..."}`. Jobs and results are isolated by client ID.

For production client behavior, stable error codes, retry guidance, SSE reconnects, and webhook verification, see [External App Integration](./external-app-integration.md).

## GET /health

Public gateway health check.

## GET /v1/engines

Returns the configured tools engine and capabilities.

## POST /v1/ocr/sync

Synchronous image OCR. Multipart form field:

- `file`: PNG, JPEG, WebP, TIFF, BMP, HEIC, or HEIF image.

Limits:

- Image only.
- Max 10 MB.

## POST /v1/tools/image/convert/sync

Synchronous image conversion. Multipart form fields:

- `file`: PNG, JPEG, WebP, TIFF, BMP, HEIC, or HEIF image.
- `targetFormat`: `png`, `jpeg`, `webp`, or `avif`.
- `quality`: optional integer from 1 to 100.
- `width` and `height`: optional positive integers.
- `fit`: optional `contain`, `cover`, or `inside`; defaults to `inside`.

Returns the converted binary image directly. `Content-Type` matches the target format and `Content-Disposition` includes the converted filename. Max upload size is 10 MB.

## POST /v1/jobs

Creates an OCR job. Multipart form field:

- `file`: supported image or PDF.
- `callbackUrl`: optional HTTPS webhook URL for `ready`, `failed`, and `cancelled` notifications.
- `metadata`: optional JSON object string echoed back in webhook payloads.

Optional header:

- `Idempotency-Key`: scoped to the authenticated client. Reusing the same key returns the original job instead of creating another job.

Images and PDFs are accepted. PDFs are always async and are processed page by page. The production target is 100 pages or fewer.

## POST /v1/tools/image/convert

Creates an async image conversion job. It accepts the same conversion fields as the sync route plus optional `callbackUrl`, `metadata`, and `Idempotency-Key`.

Async conversion results are stored in R2. `GET /v1/jobs/:jobId/result` returns metadata and `GET /v1/jobs/:jobId/output` downloads the converted binary file.

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

Returns the complete OCR result once ready, or image conversion output metadata for `tool: "image.convert"` jobs.

If the job is `queued`, `processing`, or `cancel_requested`, this returns `409`. Cancelled, failed, deleted, and missing result states return an error instead of a partial result.

## GET /v1/jobs/:jobId/output

Downloads a ready job's binary output. This is currently used by `image.convert` jobs. Non-ready jobs return `409`.

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
- `X-Aleph-Tools-Signature`: `sha256=<hex hmac>` over `<timestamp>.<raw body>`.

Ready payloads include `event`, `eventId`, `jobId`, `job`, `resultUrl`, `metadata`, and `createdAt`. Image conversion ready payloads also include `outputUrl`. Failed payloads include `event`, `eventId`, `jobId`, `job`, `error`, `metadata`, and `createdAt`. Cancelled payloads include `event`, `eventId`, `jobId`, `job`, `metadata`, and `createdAt`.
