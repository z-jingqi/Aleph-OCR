#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from paddleocr import PaddleOCR

# Instantiating the engine causes PaddleOCR to resolve/download its default OCR models.
PaddleOCR(lang='ch')
print('PaddleOCR default models are available.')
PY
