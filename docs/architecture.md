# Architecture

Aleph-OCR is intentionally split into a lightweight edge gateway and a heavier OCR engine.

## Gateway Worker

The Worker owns public HTTP behavior:

- API-key authentication for `/v1/*`.
- Request validation and file type limits.
- Sync image OCR proxying for small images.
- Async job creation, status, result, and deletion.
- D1 job metadata, R2 source/result storage, and Queue dispatch.
- Scheduled cleanup of expired files and results.

The gateway stores only generic OCR metadata. Client applications should keep their own domain identifiers outside Aleph-OCR and map them to Aleph job IDs in their own systems.

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

Current v1 stores a complete result JSON per job. A later hardening step can store each page result separately so failed pages can be retried without restarting the whole document.
