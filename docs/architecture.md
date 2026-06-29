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
- PDF text-layer inspection and extraction with PyMuPDF.
- PDF rasterization for scanned pages.
- Per-page OCR and result building.
- Image conversion, compression, and resizing with Pillow.

The container is private implementation detail. Production deploys it behind the Cloudflare Container binding with no public route or custom domain. External applications must call the Gateway only.

## Image Pipeline

Image OCR traffic should use `POST /v1/tools/image/pipeline`. The Gateway creates one job and plans necessary conversion, OCR-friendly compression, then OCR. JPEG, PNG, TIFF, and BMP skip conversion; WebP, HEIC, and HEIF require conversion unless the caller disables it, in which case the request fails before a job is created.

Standalone `image.convert` and `image.compress` jobs remain independent tools and never trigger OCR. The pipeline also enables an OCR-only temporary preprocessing path inside the container: EXIF normalization, RGB conversion, a mode-specific max-side guard, and light document-region crop. That temporary image is only OCR input; the public binary output remains the final converted/compressed image stored in R2.

## Long PDFs

PDFs are async by default. The container enforces:

- `MAX_PDF_PAGES=100`
- `PDF_BATCH_SIZE=5`
- `PDF_RENDER_DPI` follows the requested PP-OCRv6 mode: `tiny=140`, `small=170`, `medium=220`.

The default PDF strategy is text-layer first:

- `pdfExtractionMode=auto` inspects every page. Pages with usable embedded text are extracted directly; scanned pages are rasterized and sent to PP-OCRv6.
- `pdfExtractionMode=text` requires usable embedded text on every page and fails the job when a page cannot be extracted as text.
- `pdfExtractionMode=ocr` skips text extraction and uses PP-OCRv6 for every page.

The gateway stores page results in D1/R2 before merging the final result, so retries, cancellation, SSE progress, and webhook delivery continue to use the job state machine as the source of truth. Text-layer pages do not run OCR fallback; OCR pages keep the existing low-quality fallback to `medium`.

## Document Structure

Current PDF processing intentionally stays on PP-OCRv6 plus PyMuPDF text extraction. Text PDFs can return embedded text and coordinates without raster OCR; scanned pages are rasterized page by page, OCR is run per page, and the final result merges page text, blocks, confidence, quality, extraction method, and timings. This is text extraction, not full document understanding.

Aleph Tools does not currently run PP-StructureV3. That means table structure, cross-page table continuation, layout semantics, and field-level document understanding are not guaranteed by the OCR result. For documents such as medical reports or complex statements, a downstream parser can use the OCR text and block coordinates, but it should not assume the OCR engine has already identified semantic columns or table cells.

If structured document understanding becomes required, add PP-StructureV3 as a separate tool rather than replacing the existing OCR path. The preferred shape is a dedicated async endpoint such as `POST /v1/tools/document/structure`, with its own container workload, queue/concurrency limits, result schema, and benchmark gates. This keeps fast PP-OCRv6 OCR stable while allowing heavier layout/table extraction to evolve independently.
