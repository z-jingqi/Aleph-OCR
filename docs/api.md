# API

All `/v1/*` routes require:

```http
Authorization: Bearer <api-key>
```

## GET /health

Public gateway health check.

## GET /v1/engines

Returns the configured OCR engine and capabilities.

## POST /v1/ocr/sync

Synchronous image OCR. Multipart form field:

- `file`: PNG, JPEG, WebP, TIFF, or BMP image.

Limits:

- Image only.
- Max 10 MB.

## POST /v1/jobs

Creates an OCR job. Multipart form field:

- `file`: supported image or PDF.

Images and PDFs are accepted. PDFs are always async.

## GET /v1/jobs/:jobId

Returns job metadata and status. Status values:

- `queued`
- `processing`
- `ready`
- `failed`
- `deleted`

## GET /v1/jobs/:jobId/result

Returns the complete OCR result once ready.

## DELETE /v1/jobs/:jobId

Marks a job deleted and removes its in-memory result.
