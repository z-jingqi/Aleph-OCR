# Architecture

Aleph Tools is intentionally split into a lightweight edge gateway and a heavier tools engine. OCR remains a first-class API, and image conversion/compression use the same async job infrastructure.

## Gateway Worker

The Worker owns public HTTP behavior:

- API-key authentication for `/v1/*`.
- Request validation and file type limits.
- Sync image OCR, image conversion, and image compression proxying for small images.
- Async job creation, status, result, binary output, cancellation, and deletion.
- D1 job metadata/events, R2 source/result/output storage, Workflow orchestration, and Queue fallback dispatch.
- Scheduled cleanup of expired files, results, and outputs.

The gateway stores only generic tool metadata. Client applications should keep their own domain identifiers outside Aleph Tools and map them to Aleph job IDs in their own systems.

## Tools Container

The container owns CPU-heavy work:

- PaddleOCR model loading and inference.
- Image OCR.
- PDF rasterization with PyMuPDF.
- Per-page OCR and result merging.
- Image conversion, compression, and resizing with Pillow.

The container is private implementation detail. Production deploys it behind the Cloudflare Container binding with no public route or custom domain. External applications must call the Gateway only.

## Long PDFs

PDFs are async by default. The container enforces:

- `MAX_PDF_PAGES=100`
- `PDF_BATCH_SIZE=5`
- `PDF_RENDER_DPI` follows the requested PP-OCRv6 mode: `tiny=140`, `small=170`, `medium=220`.

Current v1 stores a complete result JSON per job. A later hardening step can store each page result separately so failed pages can be retried without restarting the whole document.
