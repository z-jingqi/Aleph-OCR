# OCR Test Fixtures

These files are local-only OCR fixtures for gateway and async job tests.

Images:

- `images/receipt.png` - generated receipt image for sync image OCR paths.
- `images/invoice-table.png` - generated invoice/table image for layout-style OCR paths.
- `images/checklist-photo.png` - generated mobile-photo-style note for less ideal image input.

PDFs:

- `pdfs/receipt-single-page.pdf` - single-page image-backed receipt PDF.
- `pdfs/mixed-two-page.pdf` - two-page image-backed PDF using the invoice and checklist images.

The source images were generated with the built-in Codex `imagegen` tool and then copied into this repository for deterministic test use.
