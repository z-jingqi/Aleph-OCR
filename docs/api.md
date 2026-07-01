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

Content type must be `multipart/form-data`.

Multipart fields:

| Field | Required | Description |
|---|---:|---|
| `file` | Yes | Image file. |
| `callbackUrl` | No | HTTPS webhook URL for terminal events. |
| `metadata` | No | JSON object string echoed in webhook payloads. |

Unknown multipart fields are rejected.

Headers:

| Header | Required | Description |
|---|---:|---|
| `Idempotency-Key` | No | At most 256 characters. Reusing the same key with the same upload identity returns the original job. Reusing it with a different upload identity returns `IDEMPOTENCY_CONFLICT`. |

Limits:

| Limit | Value |
|---|---|
| Default async upload size | 10 MiB unless the deployment overrides `MAX_IMAGE_UPLOAD_BYTES`. |
| Sync OCR upload size | 10 MiB. |
| `metadata` field | 4096 bytes. |
| `Idempotency-Key` | 256 characters. |

Idempotency fingerprinting currently uses filename, MIME type, size, tool, operation, and tool options. It is not a content hash.

Supported direct OCR formats: `jpeg`, `png`, `gif`, `webp`, `bmp`, `tiff`, `raw`, `dng`.

Auto-converted before OCR: `heic`, `heif`. Conversion is internal and always targets JPEG.

Unsupported in this version: PDF, AVIF, and unknown image formats.

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

## Job Source Image

`GET /v1/jobs/:jobId/source`

Returns the original source image saved temporarily for the job. The R2 bucket remains private; callers must use this authenticated Worker route.

Source images are available while the job is not `deleted`, including `queued`, `processing`, `cancel_requested`, `ready`, `failed`, and `cancelled` jobs. Stored files are retained for at most 3 days. Deleted or expired jobs return `410 JOB_DELETED`.

The response is the image byte stream with the original `Content-Type` and an inline `Content-Disposition` filename.

If the job exists but the R2 source object is missing, the route returns `500 SOURCE_NOT_FOUND` with `retryable=true`.

## Events

`GET /v1/jobs/:jobId/events`

Returns `text/event-stream`. On connect, the stream sends a `job.snapshot` event, then stored job events. Clients may reconnect with `Last-Event-ID`.

Stored event names:

- `job.created`
- `job.status`
- `job.progress`
- `job.ready`
- `job.failed`
- `job.cancel_requested`
- `job.cancelled`
- `job.deleted`

The stream may also emit `ping` events while waiting.

## Cancel

`POST /v1/jobs/:jobId/cancel`

Queued jobs become `cancelled`. Processing jobs become `cancel_requested` and will stop before writing `ready` if cancellation is observed before result storage.

## Delete

`DELETE /v1/jobs/:jobId`

Deletes source/result objects and marks the job `deleted`. Deleted jobs cannot return the result or source image.

## Engine Info

`GET /v1/engines`

Returns current OCR engine metadata. The provider is currently `google-vision` with `DOCUMENT_TEXT_DETECTION`.

## Health

`GET /health`

Returns service health metadata. This route is outside `/v1` and does not require API-key authentication.

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
| `VALIDATION_ERROR` | Request shape, unsupported field, malformed metadata, or idempotency key length is invalid. |
| `UNAUTHORIZED` | Missing or invalid API key. |
| `STORAGE_UNAVAILABLE` | D1 or R2 binding is unavailable. |
| `WORKFLOW_UNAVAILABLE` | Workflow/queue processing backend is unavailable. |
| `UNSUPPORTED_MEDIA_TYPE` | Not an image, or PDF uploaded. |
| `UNSUPPORTED_FORMAT` | Image format cannot be converted for OCR. |
| `FILE_TOO_LARGE` | Uploaded image exceeds configured limit. |
| `ENGINE_UNAVAILABLE` | Google Vision or Cloudflare Images is unavailable or misconfigured. |
| `RATE_LIMITED` | Google Vision quota/rate limit. |
| `JOB_NOT_FOUND` | Job is missing or belongs to another client/API key. |
| `JOB_NOT_READY` | Result requested before `ready`. |
| `JOB_FAILED` | Terminal failed job. |
| `JOB_CANCELLED` | Terminal cancelled job. |
| `JOB_DELETED` | Terminal deleted job. |
| `RESULT_NOT_FOUND` | Ready job result object is missing; report `requestId` and `jobId`. |
| `SOURCE_NOT_FOUND` | Job source object is missing; report `requestId` and `jobId`. |
| `IDEMPOTENCY_CONFLICT` | Same idempotency key was used with a different upload identity. |
| `INTERNAL_ERROR` | Unexpected service error. |
