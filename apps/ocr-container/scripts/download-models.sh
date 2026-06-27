#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="${PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:-True}"
export PADDLEOCR_HOME="${PADDLEOCR_HOME:-/models/paddleocr}"
export PADDLE_PDX_CACHE_HOME="${PADDLE_PDX_CACHE_HOME:-${PADDLEOCR_HOME}}"
export PYTHONPATH="${APP_DIR}:${PYTHONPATH:-}"

python - <<'PY'
from src.ocr_engine import OCR_MODES, get_ocr

# Instantiating each configured engine causes PaddleOCR to resolve/download its models.
for mode in OCR_MODES:
    get_ocr(mode)
    print(f'PaddleOCR models for {mode} mode are available.')
PY
