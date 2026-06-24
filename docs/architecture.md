# Architecture

Aleph-OCR is intentionally split into a lightweight edge gateway and a heavier OCR engine.

## Gateway Worker

The Worker owns public HTTP behavior:

- API-key authentication for `/v1/*`.
- Request validation and file type limits.
- Sync image OCR proxying for small images.
- Async job creation, status, result, and deletion.
- Future D1/R2/Queue integration points.

The prototype uses an in-memory job store. This is not durable across Worker restarts and is only for local development and first integration testing.

## OCR Container

The container owns CPU-heavy work:

- PaddleOCR model loading and inference.
- Image OCR.
- PDF rasterization with PyMuPDF.
- Per-page OCR and result merging.

The container does not expose public project authentication. It should only be reachable from the gateway or a trusted internal network.

## Long PDFs

PDFs are async by default. The container enforces:

- `MAX_PDF_PAGES=100`
- `PDF_BATCH_SIZE=5`
- `PDF_RENDER_DPI=200`

The first production hardening step is to store each page result in R2/D1 so failed pages can be retried without restarting the whole document.
