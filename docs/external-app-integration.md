# External App Integration

This document is the integration contract for business applications using Aleph Tools image OCR. An external application should be able to implement upload, temporary source image retrieval, polling/SSE/webhook waiting, result retrieval, cancellation, deletion, and error handling from this file alone.

## Environment

Use the base URL and credentials assigned to your application:

| Environment | Base URL |
|---|---|
| Preview | `https://preview-tools.aleph-cat.com` |
| Production | `https://tools.aleph-cat.com` |

Every `/v1/*` request requires:

```http
Authorization: Bearer <api-key>
```

Each API key maps to one stable internal `clientId`. Jobs, idempotency keys, and results are isolated by that client. The `clientId` is not currently returned in public API responses.

## Endpoint Summary

| Purpose | Method and path | Response |
|---|---|---|
| Create OCR job | `POST /v1/tools/ocr` | JSON job snapshot, HTTP 202. |
| Read job status | `GET /v1/jobs/:jobId` | JSON job snapshot. |
| Read OCR result | `GET /v1/jobs/:jobId/result` | JSON OCR result, only when `resultAvailable=true`. |
| Read temporary source image | `GET /v1/jobs/:jobId/source` | Original image byte stream until cleanup. |
| Stream job events | `GET /v1/jobs/:jobId/events` | SSE stream. |
| Request cancellation | `POST /v1/jobs/:jobId/cancel` | JSON job snapshot. |
| Delete job and stored files | `DELETE /v1/jobs/:jobId` | JSON job snapshot. |
| Engine metadata | `GET /v1/engines` | JSON engine metadata. |
| Health check | `GET /health` | JSON health metadata; no API key required. |

Binary endpoints return image bytes on success. Non-2xx failures still use the standard JSON error shape.

## Request Flow

```text
Upload image
  -> POST /v1/tools/ocr
  -> receive job snapshot
  -> optionally GET /v1/jobs/:jobId/source for short-lived source inspection
  -> wait via SSE, webhook, or polling
  -> GET /v1/jobs/:jobId/result when resultAvailable=true
```

Recommended integration:

1. Send `POST /v1/tools/ocr` with an `Idempotency-Key`.
2. Store the returned `jobId`.
3. Optionally read `/source` for short-lived source inspection while the job exists.
4. Wait for `status=ready`, `failed`, or `cancelled` using SSE or webhook.
5. Read `/v1/jobs/:jobId/result` only when `resultAvailable=true`.
6. Branch on stable fields such as `status`, `error.code`, `retryable`, and `terminal`. Do not parse message text.

Minimum backend state to store:

| Field | Why store it |
|---|---|
| `jobId` | Required for status, result, source image, cancel, and delete calls. |
| `Idempotency-Key` | Lets your create request be retried safely after network failures. |
| `metadata.documentId` or equivalent | Maps the OCR job back to your business object. |
| `expiresAt` | Helps your app stop offering source/result downloads after cleanup. Jobs and stored files are retained for at most 3 days. |

## Supported Files

The service supports image OCR only.

| Category | Formats | Behavior |
|---|---|---|
| Direct OCR | `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `tif`, `tiff`, `raw`, `dng` | Sent directly to Google Vision. |
| Auto-converted before OCR | `heic`, `heif` | Converted to JPEG through Cloudflare Images, then sent to Google Vision. |
| Unsupported | `pdf`, `svg`, `avif`, videos such as `mov`/`mp4`, unknown image formats | Rejected before OCR. |

Notes:

- `dng` and `raw` are intended for Android RAW/pro camera uploads and are not converted.
- `avif` is not accepted in the current deployment because Cloudflare Images AVIF input requires an Enterprise plan.
- There is no standalone image conversion, compression, PDF OCR, table extraction, field extraction, or local OCR engine in this version.

## Upload Constraints

`POST /v1/tools/ocr` accepts only `multipart/form-data`.

Allowed multipart fields:

| Field | Required | Description |
|---|---:|---|
| `file` | Yes | The image file to OCR. |
| `callbackUrl` | No | `http` or `https` webhook URL for terminal events. Production integrations should use `https`. |
| `metadata` | No | JSON object string, at most 4096 bytes, echoed in webhook payloads. |

Unknown multipart fields are rejected. Removed fields from older OCR versions, such as OCR mode or image compression options, are not accepted.

Headers:

| Header | Required | Description |
|---|---:|---|
| `Authorization` | Yes | `Bearer <api-key>`. |
| `Idempotency-Key` | No | At most 256 characters. Recommended for all creates. |

Size limits:

| Limit | Value |
|---|---|
| Default async upload size | 10 MiB unless the deployment overrides `MAX_IMAGE_UPLOAD_BYTES`. |
| Sync OCR upload size | 10 MiB. |
| `metadata` field | 4096 bytes. |
| `Idempotency-Key` | 256 characters. |

Idempotency behavior:

- Reusing the same key with the same upload identity returns the original job.
- Reusing the same key with a different upload identity returns `IDEMPOTENCY_CONFLICT`.
- The current fingerprint uses filename, MIME type, size, tool, operation, and tool options. It is not a content hash.
- If job creation succeeds but workflow start fails before processing begins, the unstarted job is abandoned and the same key can be retried.

## Create OCR Job

`POST /v1/tools/ocr`

```bash
curl -X POST "$ALEPH_TOOLS_URL/v1/tools/ocr" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY" \
  -H "Idempotency-Key: upload-123" \
  -F "file=@receipt.heic" \
  -F 'metadata={"source":"mobile","documentId":"doc_123"}' \
  -F "callbackUrl=https://app.example.com/webhooks/aleph-tools"
```

Successful response:

```json
{
  "success": true,
  "data": {
    "jobId": "job_123",
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
    "createdAt": "2026-07-01T00:00:00.000Z",
    "updatedAt": "2026-07-01T00:00:00.000Z",
    "expiresAt": "2026-07-04T00:00:00.000Z",
    "terminal": false,
    "cancelable": true,
    "retryable": true,
    "resultAvailable": false
  },
  "requestId": "req_123"
}
```

## Job Status

`GET /v1/jobs/:jobId`

```bash
curl "$ALEPH_TOOLS_URL/v1/jobs/job_123" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Use these fields for client state:

| Field | Meaning |
|---|---|
| `status` | `queued`, `processing`, `cancel_requested`, `cancelled`, `ready`, `failed`, or `deleted`. |
| `stage` | More specific processing stage, such as `reading_source`, `converting`, `ocr`, or `storing_result`. |
| `progress` | Integer from 0 to 100. Informational; do not use as a correctness signal. |
| `terminal` | True when no more processing will happen. |
| `cancelable` | True when cancellation can still be requested. |
| `retryable` | Whether the client may retry the same high-level operation. |
| `resultAvailable` | True when `/result` can be read. |

Terminal statuses:

- `ready`
- `failed`
- `cancelled`
- `deleted`

## Job Result

`GET /v1/jobs/:jobId/result`

Only `ready` jobs return OCR JSON. Active jobs return `409 JOB_NOT_READY`. Failed, cancelled, or deleted jobs return their terminal error code.

```bash
curl "$ALEPH_TOOLS_URL/v1/jobs/job_123/result" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Successful response:

```json
{
  "success": true,
  "data": {
    "jobId": "job_123",
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
        "blocks": [
          {
            "text": "OCR text",
            "bbox": [0, 0, 100, 0, 100, 20, 0, 20],
            "confidence": 0.95
          }
        ],
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
      },
      "timingsMs": {
        "googleVision": 300,
        "normalize": 5,
        "total": 305
      }
    }
  },
  "requestId": "req_124"
}
```

Important result fields:

- `plainText`: all recognized text.
- `markdown`: currently the same text-oriented output as `plainText`.
- `pages[].blocks`: Google Vision text blocks with optional bounding boxes and confidence.
- `metadata.provider`: always `google-vision`.
- `metadata.feature`: always `DOCUMENT_TEXT_DETECTION`.
- `metadata.input.converted`: whether the uploaded image was converted before OCR.
- `metadata.input.originalMimeType`: original MIME type when conversion happened.

The result does not promise table structure or field extraction. Business applications should perform domain parsing on top of `plainText` and blocks.

## Source Image

`GET /v1/jobs/:jobId/source`

Returns the original source image saved temporarily for the job. The image is streamed through the authenticated API; R2 is not public and no permanent image URL is exposed.

```bash
curl "$ALEPH_TOOLS_URL/v1/jobs/job_123/source" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY" \
  --output source-image
```

Behavior:

- Available for `queued`, `processing`, `cancel_requested`, `ready`, `failed`, and `cancelled` jobs.
- Returns `410 JOB_DELETED` after the job is deleted or expired by cleanup.
- Returns `404 JOB_NOT_FOUND` when the job belongs to a different API key/client.
- Returns `500 SOURCE_NOT_FOUND` if the job record exists but the R2 source object is missing.
- Source images are retained for at most 3 days, then deleted by scheduled cleanup.

Response headers:

```http
Content-Type: image/jpeg
Content-Disposition: inline; filename="receipt.jpg"
Cache-Control: private, max-age=300
```

Browser display note: this endpoint requires an `Authorization` header, so frontend code cannot usually use it directly as `<img src="...">`. Do not expose `ALEPH_TOOLS_API_KEY` to untrusted browsers. Use one of these patterns:

- Recommended for production: have your backend call Aleph Tools and proxy the image to your frontend under your own session authorization.
- Acceptable only for internal or otherwise trusted clients: fetch with `Authorization`, convert the response to a `Blob`, then render an object URL.

Example frontend blob rendering:

```js
async function loadSourcePreview(jobId, apiKey) {
  const response = await fetch(`${ALEPH_TOOLS_URL}/v1/jobs/${jobId}/source`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw await response.json();
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
```

Aleph Tools does not provide a thumbnail endpoint. If your product needs thumbnails or long-term image display, generate and store those assets in your own application storage.


## SSE Events

`GET /v1/jobs/:jobId/events`

Returns `text/event-stream`. On connect, the stream sends a `job.snapshot` event, then stored job events. The stream also sends `ping` events while waiting.

```bash
curl -N "$ALEPH_TOOLS_URL/v1/jobs/job_123/events" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Resume after reconnect:

```http
Last-Event-ID: 7
```

Example events:

```text
id: 0
event: job.snapshot
data: {"jobId":"job_123","status":"processing","progress":70,"stage":"ocr","terminal":false,"resultAvailable":false}

id: 8
event: job.ready
data: {"jobId":"job_123","status":"ready","progress":100,"stage":"ready","resultUrl":"/v1/jobs/job_123/result"}

event: ping
data: {"timestamp":"2026-07-01T00:00:15.000Z"}
```

Recommended client behavior:

- Connect after creating the job.
- Persist the last SSE event id.
- Reconnect with `Last-Event-ID` after refresh or network loss.
- Treat `job.snapshot` as the current source of truth after reconnect.
- Still call `GET /v1/jobs/:jobId/result` for the final OCR JSON.

## Webhooks

Set `callbackUrl` when creating the job to receive terminal events.

Terminal webhook event names:

- `ocr.job.ready`
- `ocr.job.failed`
- `ocr.job.cancelled`

Headers:

```http
Content-Type: application/json
X-Aleph-Tools-Event-Id: evt_123
X-Aleph-Tools-Delivery-Id: whd_123
X-Aleph-Tools-Timestamp: 2026-07-01T00:00:00.000Z
X-Aleph-Tools-Signature: sha256=<hmac>
```

Verify the signature with the per-client webhook secret:

```text
sha256 = HMAC_SHA256(secret, timestamp + "." + rawBody)
```

Use the exact raw request body bytes/string received by your server. Do not reserialize JSON before verification.

Ready webhook payload:

```json
{
  "event": "ocr.job.ready",
  "eventId": "evt_123",
  "jobId": "job_123",
  "metadata": { "source": "mobile", "documentId": "doc_123" },
  "createdAt": "2026-07-01T00:01:00.000Z",
  "resultUrl": "/v1/jobs/job_123/result",
  "job": {
    "jobId": "job_123",
    "status": "ready",
    "progress": 100,
    "stage": "ready",
    "terminal": true,
    "resultAvailable": true
  }
}
```

Webhook payloads contain `resultUrl` for ready jobs. They do not include source URLs; construct the temporary source URL from `jobId` only if needed:

```text
/v1/jobs/<jobId>/source
```

Failed webhook payload:

```json
{
  "event": "ocr.job.failed",
  "eventId": "evt_124",
  "jobId": "job_123",
  "metadata": {},
  "createdAt": "2026-07-01T00:01:00.000Z",
  "job": {
    "jobId": "job_123",
    "status": "failed",
    "terminal": true,
    "resultAvailable": false
  },
  "error": {
    "code": "JOB_FAILED",
    "message": "Google Vision request failed",
    "jobStatus": "failed",
    "stage": "failed",
    "retryable": false,
    "terminal": true
  }
}
```

Webhook delivery behavior:

- Return any 2xx response to mark the delivery successful.
- Non-2xx responses or network failures are retried with backoff.
- Webhook retry failure never rolls back job state.
- Webhook delivery is best-effort notification; `GET /v1/jobs/:jobId` remains the source of truth.

## Cancel Jobs

`POST /v1/jobs/:jobId/cancel`

```bash
curl -X POST "$ALEPH_TOOLS_URL/v1/jobs/job_123/cancel" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Behavior:

- Queued jobs become `cancelled`.
- Processing jobs become `cancel_requested`.
- A processing job stops before writing `ready` if cancellation is observed before result storage.
- Terminal jobs remain unchanged.

## Delete Jobs

`DELETE /v1/jobs/:jobId`

```bash
curl -X DELETE "$ALEPH_TOOLS_URL/v1/jobs/job_123" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY"
```

Behavior:

- Source and result objects are deleted from storage.
- The job snapshot is marked `deleted`.
- Deleted jobs cannot return a result or source image.

## Engine Info

`GET /v1/engines`

Returns current OCR engine metadata. The provider is currently `google-vision` with `DOCUMENT_TEXT_DETECTION`.

## Health

`GET /health`

This route does not require `/v1` authentication and returns service health metadata.

## Error Handling

All JSON errors use:

```json
{
  "success": false,
  "error": {
    "code": "JOB_NOT_READY",
    "message": "Job result is not ready; current status is processing",
    "httpStatus": 409,
    "requestId": "req_123",
    "jobId": "job_123",
    "jobStatus": "processing",
    "stage": "ocr",
    "retryable": true,
    "terminal": false
  },
  "requestId": "req_123"
}
```

Branch on `error.code`, `error.jobStatus`, `error.retryable`, and `error.terminal`.

| Code | HTTP | Client action |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Fix request shape, unsupported fields, malformed metadata, or idempotency key length. |
| `UNAUTHORIZED` | 401 | Check API key provisioning. |
| `STORAGE_UNAVAILABLE` | 503 | Retry later; report `requestId` if persistent. |
| `WORKFLOW_UNAVAILABLE` | 503 | Retry later; job processing backend is unavailable. |
| `ENGINE_UNAVAILABLE` | 503 | Retry later if `retryable=true`; otherwise report service configuration issue. |
| `UNSUPPORTED_MEDIA_TYPE` | 400 or 415 | Ask user for an image file. |
| `UNSUPPORTED_FORMAT` | 400 | Ask user to export as JPEG/PNG/HEIC/HEIF or another supported image. |
| `FILE_TOO_LARGE` | 413 | Ask user to upload a smaller image. |
| `JOB_NOT_FOUND` | 404 | Confirm the `jobId` belongs to the same API key/client. |
| `JOB_NOT_READY` | 409 | Continue waiting through SSE, webhook, or polling. |
| `JOB_FAILED` | 409 | Show terminal failure and allow user retry with a new upload. |
| `JOB_CANCELLED` | 409 | Stop waiting and reflect cancellation. |
| `JOB_DELETED` | 410 | Stop waiting; result/source are no longer available. |
| `RESULT_NOT_FOUND` | 500 | Report `requestId` and `jobId`; this is a service consistency issue. |
| `SOURCE_NOT_FOUND` | 500 | Report `requestId` and `jobId`; this is a service consistency issue. |
| `IDEMPOTENCY_CONFLICT` | 409 | Use a new idempotency key for a different upload. |
| `RATE_LIMITED` | 429 | Retry later with backoff; honor `Retry-After` when present. |
| `INTERNAL_ERROR` | 500 | Retry if appropriate; report `requestId` if persistent. |

## Recommended State Machine

```text
create request accepted
  -> queued
  -> processing
       -> ready -> read result
       -> failed
       -> cancel_requested -> cancelled
  -> deleted
```

Implementation rules:

- `ready`, `failed`, `cancelled`, and `deleted` are terminal.
- Only call `/result` when `resultAvailable=true`.
- `/source` is available until the job is deleted or expires, for at most 3 days.
- Binary source success responses are not wrapped in `{ success, data }`; error responses are JSON.
- Use a new upload/idempotency key after `failed` unless the original create request itself failed before job acceptance.
- Treat webhook and SSE as notifications. Confirm important state through `GET /v1/jobs/:jobId` if your application needs strict consistency.
