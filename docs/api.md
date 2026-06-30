# Aleph Tools API

Current version: image OCR only.

## Authentication

Every `/v1/*` request requires:

```http
Authorization: Bearer <api-key>
```

API keys are configured in `ALEPH_TOOLS_API_KEYS`, keyed by stable `clientId`.

## Create OCR Job

`POST /v1/tools/ocr`

Multipart fields:

| Field | Required | Description |
|---|---:|---|
| `file` | Yes | Image file. |
| `callbackUrl` | No | HTTPS webhook URL for terminal events. |
| `metadata` | No | JSON object string echoed in webhook payloads. |

Headers:

| Header | Required | Description |
|---|---:|---|
| `Idempotency-Key` | No | Reusing the same key with the same file returns the original job. Reusing it with a different file returns `IDEMPOTENCY_CONFLICT`. |

Supported direct OCR formats: `jpeg`, `png`, `gif`, `webp`, `bmp`, `tiff`.

Auto-converted before OCR: `heic`, `heif`, `avif`. Conversion is internal and always targets JPEG.

Unsupported in this version: PDF and unknown image formats.

Response:

```json
{
  "success": true,
  "data": {
    "jobId": "job_...",
    "tool": "ocr",
    "operation": "ocr",
    "status": "queued",
    "progress": 0,
    "stage": "queued",
    "document": {
      "type": "image",
      "filename": "receipt.heic",
      "mimeType": "image/heic",
      "sizeBytes": 12345
    },
    "terminal": false,
    "cancelable": true,
    "retryable": true,
    "resultAvailable": false
  },
  "requestId": "req_..."
}
```

## Sync OCR

`POST /v1/tools/ocr/sync`

Same multipart shape as async OCR, but returns OCR result directly. This route is only enabled when `ENABLE_SYNC_ENDPOINTS=true` and is intended for local smoke tests or tightly controlled internal debugging.

## Job Status

`GET /v1/jobs/:jobId`

Use `data.status`, `data.terminal`, `data.cancelable`, and `data.resultAvailable` for application state.

Terminal statuses:

- `ready`
- `failed`
- `cancelled`
- `deleted`

## Job Result

`GET /v1/jobs/:jobId/result`

Only `ready` jobs return OCR JSON. Active jobs return `409 JOB_NOT_READY`; failed/cancelled/deleted jobs return their terminal error code.

Result shape:

```json
{
  "success": true,
  "data": {
    "jobId": "job_...",
    "status": "ready",
    "engine": "google-vision",
    "engineVersion": "v1",
    "document": {
      "type": "image",
      "filename": "receipt.from-heic.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 34567
    },
    "pages": [
      {
        "pageIndex": 0,
        "width": 1024,
        "height": 768,
        "text": "OCR text",
        "blocks": [{ "text": "OCR text", "bbox": [0, 0, 100, 0, 100, 20, 0, 20], "confidence": 0.95 }],
        "tables": [],
        "confidence": 0.95
      }
    ],
    "plainText": "OCR text",
    "markdown": "OCR text",
    "metadata": {
      "provider": "google-vision",
      "feature": "DOCUMENT_TEXT_DETECTION",
      "input": {
        "filename": "receipt.from-heic.jpg",
        "mimeType": "image/jpeg",
        "sizeBytes": 34567,
        "converted": true,
        "originalMimeType": "image/heic"
      }
    }
  },
  "requestId": "req_..."
}
```

## Events

`GET /v1/jobs/:jobId/events`

Returns `text/event-stream`. On connect, the stream sends a `job.snapshot` event, then stored job events. Clients may reconnect with `Last-Event-ID`.

## Cancel

`POST /v1/jobs/:jobId/cancel`

Queued jobs become `cancelled`. Processing jobs become `cancel_requested` and will stop before writing `ready` if cancellation is observed before result storage.

## Error Shape

All JSON errors use:

```json
{
  "success": false,
  "error": {
    "code": "JOB_NOT_READY",
    "message": "Job result is not ready; current status is processing",
    "httpStatus": 409,
    "requestId": "req_...",
    "jobId": "job_...",
    "jobStatus": "processing",
    "stage": "ocr",
    "retryable": true,
    "terminal": false
  },
  "requestId": "req_..."
}
```

Important codes:

| Code | Meaning |
|---|---|
| `UNSUPPORTED_MEDIA_TYPE` | Not an image, or PDF uploaded. |
| `UNSUPPORTED_FORMAT` | Image format cannot be converted for OCR. |
| `ENGINE_UNAVAILABLE` | Google Vision or Cloudflare Images is unavailable or misconfigured. |
| `RATE_LIMITED` | Google Vision quota/rate limit. |
| `JOB_NOT_READY` | Result requested before `ready`. |
| `JOB_FAILED` | Terminal failed job. |
| `JOB_CANCELLED` | Terminal cancelled job. |
| `RESULT_NOT_FOUND` | Ready job result object is missing; report `requestId` and `jobId`. |
