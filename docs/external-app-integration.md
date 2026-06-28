# External App Integration

This document is the contract external applications should use when integrating with Aleph Tools.

## Response Shape

All authenticated JSON endpoints return a request id in the body and as the `X-Request-Id` response header. Callers may send `X-Request-Id`; otherwise the gateway generates `req_<uuid>`.

Successful JSON responses:

```json
{
  "success": true,
  "data": {},
  "requestId": "req_..."
}
```

Error responses:

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

External applications should branch on `error.code`, not `message`.

## Job Snapshot Fields

`GET /v1/jobs/:jobId`, SSE snapshots, and webhook `job` payloads use the same job shape:

```json
{
  "jobId": "job_...",
  "tool": "ocr",
  "operation": "ocr",
  "status": "processing",
  "stage": "ocr",
  "progress": 50,
  "currentPage": 1,
  "totalPages": 10,
  "terminal": false,
  "cancelable": true,
  "retryable": true,
  "resultAvailable": false,
  "outputAvailable": false,
  "createdAt": "...",
  "updatedAt": "...",
  "expiresAt": "..."
}
```

Status values:

- `queued`: accepted but not yet running.
- `processing`: actively running.
- `cancel_requested`: cancellation requested; no new work will start.
- `ready`: terminal success; result is available.
- `failed`: terminal failure.
- `cancelled`: terminal cancellation.
- `deleted`: terminal deletion or cleanup.

Recommended UI behavior:

- Show progress from `progress`, `stage`, `currentPage`, and `totalPages`.
- Enable cancel only when `cancelable` is true.
- Read `/result` only when `resultAvailable` is true.
- Read `/output` only when `outputAvailable` is true.
- Treat `terminal` as the authoritative completion marker.

## Error Codes

| Code | HTTP | Retry | Meaning |
| --- | ---: | --- | --- |
| `VALIDATION_ERROR` | 400 | No | Invalid form field, metadata, or idempotency header. |
| `UNAUTHORIZED` | 401 | No | Missing or invalid API key. |
| `STORAGE_UNAVAILABLE` | 503 | Yes | D1 or R2 binding is unavailable. |
| `WORKFLOW_UNAVAILABLE` | 503 | Yes | Workflow or queue binding is unavailable. |
| `ENGINE_UNAVAILABLE` | 503 | Yes | Container/engine call failed or returned a 5xx error. |
| `UNSUPPORTED_MEDIA_TYPE` | 415/400 | No | Uploaded content type is unsupported. |
| `UNSUPPORTED_FORMAT` | 501/400 | No | Requested conversion or engine capability is unavailable. |
| `FILE_TOO_LARGE` | 413 | No | Upload exceeds the configured limit. |
| `JOB_NOT_FOUND` | 404 | No | Job does not exist or belongs to another client. |
| `JOB_NOT_READY` | 409 | Yes | Job exists but result/output is not ready. |
| `JOB_FAILED` | 409 | No | Job reached terminal failure. |
| `JOB_CANCELLED` | 409 | No | Job was cancelled. |
| `JOB_DELETED` | 410 | No | Job was deleted or expired. |
| `RESULT_NOT_FOUND` | 500 | Yes | Job is ready but the result object is missing. |
| `OUTPUT_NOT_FOUND` | 500 | Yes | Job is ready but the binary output object is missing. |
| `CANCEL_NOT_ALLOWED` | 409 | No | Cancellation is not valid for the current state. |
| `IDEMPOTENCY_CONFLICT` | 409 | No | Same key was reused with different file or options. |
| `RATE_LIMITED` | 429 | Yes | Client has too many active jobs. |
| `INTERNAL_ERROR` | 500 | Yes | Unexpected gateway error. |

## Creating Jobs

OCR async job:

```bash
curl -X POST "$BASE_URL/v1/tools/ocr" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: upload-123" \
  -F "file=@document.pdf" \
  -F "ocrMode=small" \
  -F 'metadata={"documentId":"doc_123"}' \
  -F "callbackUrl=https://app.example/webhooks/aleph-tools"
```

Image conversion async job:

```bash
curl -X POST "$BASE_URL/v1/tools/image/convert" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: convert-asset-123" \
  -F "file=@photo.heic" \
  -F "targetFormat=jpeg" \
  -F "quality=85" \
  -F "width=1600"
```

Image compression async job:

```bash
curl -X POST "$BASE_URL/v1/tools/image/compress" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: compress-asset-123" \
  -F "file=@photo.jpg" \
  -F "targetSizeBytes=900000" \
  -F "maxWidth=1600" \
  -F "outputFormat=jpeg"
```

Use `Idempotency-Key` for all create retries. Reusing the same key with a different file, MIME type, size, tool, operation, OCR mode, conversion options, or compression options returns `IDEMPOTENCY_CONFLICT`.

Compression is independent from OCR. If an application wants OCR on a compressed image, it should call image compression first, download or retain the compressed binary, then create a separate OCR request with that file.

## Reading Results

Use `GET /v1/jobs/:jobId` as the source of truth. Only call:

- `GET /v1/jobs/:jobId/result` when `resultAvailable` is true.
- `GET /v1/jobs/:jobId/output` when `outputAvailable` is true.

If a caller reads too early, the API returns `JOB_NOT_READY` with `retryable: true`.

## SSE Progress

Connect to:

```http
GET /v1/jobs/:jobId/events
Authorization: Bearer <api-key>
Last-Event-ID: <last sequence>
```

The first event is always `job.snapshot`. Reconnect with `Last-Event-ID` after network failures. After a page refresh, load `GET /v1/jobs/:jobId` first, then reconnect to SSE for new events.

## Webhooks

Webhook deliveries are sent for `ready`, `failed`, and `cancelled` terminal states.

Headers:

- `X-Aleph-Tools-Event-Id`
- `X-Aleph-Tools-Delivery-Id`
- `X-Aleph-Tools-Timestamp`
- `X-Aleph-Tools-Signature`

The signature is:

```text
sha256=<hmac_sha256(WEBHOOK_SIGNING_SECRET, `${timestamp}.${rawBody}`)>
```

Ready payloads include `resultUrl`; image conversion and compression ready payloads also include `outputUrl`. Failed and cancelled payloads include a structured `error` object.

## Internal Engine Boundary

The OCR/tools engine Container is private. External applications must not call `/internal/*` routes or rely on engine hostnames. In production, the Gateway calls the engine through the Cloudflare Container binding; local development binds the engine only to `127.0.0.1`.

## Retry Strategy

- Retry `retryable: true` errors with exponential backoff.
- Do not retry `VALIDATION_ERROR`, `UNAUTHORIZED`, `IDEMPOTENCY_CONFLICT`, `JOB_FAILED`, `JOB_CANCELLED`, or `JOB_DELETED` without user action.
- For `RATE_LIMITED`, wait before creating more jobs for the same client.
- For `RESULT_NOT_FOUND` or `OUTPUT_NOT_FOUND`, report the `requestId` and `jobId`; this indicates a service consistency issue.
