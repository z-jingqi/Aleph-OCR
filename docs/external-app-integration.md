# External App Integration

This document is the integration contract for business applications using Aleph Tools image OCR.

## Request Flow

```text
Upload image
  -> POST /v1/tools/ocr
  -> receive job snapshot
  -> use SSE or webhook for terminal state
  -> GET /v1/jobs/:jobId/result when resultAvailable=true
```

The service supports image OCR only. PDF is rejected with `UNSUPPORTED_MEDIA_TYPE`.

## Authentication

Use the app-specific API key:

```http
Authorization: Bearer <api-key>
```

Each API key maps to a stable `clientId`. Jobs are isolated by `clientId`.

## Create OCR Job

```bash
curl -X POST "$ALEPH_TOOLS_URL/v1/tools/ocr" \
  -H "Authorization: Bearer $ALEPH_TOOLS_API_KEY" \
  -H "Idempotency-Key: upload-123" \
  -F "file=@receipt.heic" \
  -F 'metadata={"source":"mobile"}' \
  -F "callbackUrl=https://app.example.com/webhooks/aleph-tools"
```

The Gateway automatically converts `heic`, `heif`, and `avif` to JPEG before calling Google Vision. There is no conversion toggle and no compression step.

## Job Snapshot

Use these fields for client state:

| Field | Meaning |
|---|---|
| `status` | `queued`, `processing`, `cancel_requested`, `cancelled`, `ready`, `failed`, or `deleted`. |
| `terminal` | True when no more processing will happen. |
| `cancelable` | True when cancellation can still be requested. |
| `retryable` | Whether the client may retry the same high-level operation. |
| `resultAvailable` | True when `/result` can be read. |

## Results

`GET /v1/jobs/:jobId/result` returns OCR JSON only when the job is `ready`.

Important result fields:

- `plainText`: all recognized text.
- `pages[0].blocks`: Google Vision text blocks with optional bounding boxes and confidence.
- `metadata.provider`: always `google-vision`.
- `metadata.feature`: always `DOCUMENT_TEXT_DETECTION`.
- `metadata.input.converted`: whether the uploaded image was converted before OCR.
- `metadata.input.originalMimeType`: original MIME type when conversion happened.

The result does not promise table structure or field extraction. Business applications should perform their own domain parsing on top of `plainText` and blocks.

## SSE

`GET /v1/jobs/:jobId/events` returns `text/event-stream`.

Recommended client behavior:

- Connect after creating the job.
- Persist the last SSE event id.
- Reconnect with `Last-Event-ID` after refresh or network loss.
- Treat `job.snapshot` as the current source of truth after reconnect.

## Webhook

Webhook terminal events:

- `ocr.job.ready`
- `ocr.job.failed`
- `ocr.job.cancelled`

Headers:

```http
X-Aleph-Tools-Event-Id: <eventId>
X-Aleph-Tools-Timestamp: <unix-ms-or-iso>
X-Aleph-Tools-Signature: sha256=<hmac>
```

Verify the signature with the per-client webhook secret from `ALEPH_TOOLS_WEBHOOK_SECRETS[clientId]`:

```text
sha256 = HMAC_SHA256(secret, timestamp + "." + rawBody)
```

Webhook retry failure never rolls back job state.

## Error Handling

All errors use:

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

Branch on `error.code`, `error.jobStatus`, `error.retryable`, and `error.terminal`.

Key codes:

| Code | Client action |
|---|---|
| `UNSUPPORTED_MEDIA_TYPE` | Reject upload or ask user for an image file. |
| `UNSUPPORTED_FORMAT` | Ask user to export as JPEG/PNG or retry with a supported image. |
| `FILE_TOO_LARGE` | Ask user to upload a smaller image. |
| `RATE_LIMITED` | Retry later with backoff. |
| `ENGINE_UNAVAILABLE` | Retry later if `retryable=true`; otherwise report service configuration issue. |
| `JOB_NOT_READY` | Continue waiting through SSE/webhook. |
| `JOB_FAILED` | Show terminal failure and allow user retry with a new upload. |
| `JOB_CANCELLED` | Stop waiting and reflect cancellation. |
| `RESULT_NOT_FOUND` | Report `requestId` and `jobId`; this is a service consistency issue. |

## Recommended State Machine

```text
created -> queued/processing -> ready -> read result
                         └-> failed
                         └-> cancelled
```

Do not parse `message` for business logic. Use stable fields.
