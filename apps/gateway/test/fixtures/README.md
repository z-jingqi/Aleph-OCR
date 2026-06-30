# OCR Test Fixtures

These files are local-only OCR fixtures for gateway and async job tests.

Images:

- `images/receipt.png` - generated receipt image for sync image OCR paths.
- `images/invoice-table.png` - generated invoice/table image for layout-style OCR paths.
- `images/checklist-photo.png` - generated mobile-photo-style note for less ideal image input.

PDF fixtures are intentionally omitted. The current Gateway version only supports image OCR.

The source images were generated with the built-in Codex `imagegen` tool and then copied into this repository for deterministic test use.
