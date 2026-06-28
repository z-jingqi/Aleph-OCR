from __future__ import annotations

from typing import Any

from .constants import ENGINE, ENGINE_VERSION, MAX_PDF_PAGES, MAX_SYNC_IMAGE_SIZE_BYTES, PDF_BATCH_SIZE
from .modes import DEFAULT_OCR_MODE, OCR_MODE_CONFIGS, SUPPORTED_OCR_MODES


def engine_info() -> dict[str, Any]:
    return {
        "engine": ENGINE,
        "engineVersion": ENGINE_VERSION,
        "modes": list(SUPPORTED_OCR_MODES),
        "defaultMode": DEFAULT_OCR_MODE,
        "modeConfig": {mode: config.public() for mode, config in OCR_MODE_CONFIGS.items()},
        "ocrModes": list(SUPPORTED_OCR_MODES),
        "defaultOcrMode": DEFAULT_OCR_MODE,
        "modeConfigs": {mode: config.public() for mode, config in OCR_MODE_CONFIGS.items()},
        "capabilities": {
            "image": True,
            "pdf": True,
            "syncImage": True,
            "imageConvert": True,
            "imageConvertFormats": ["png", "jpeg", "webp", "avif"],
            "asyncJobs": True,
            "layout": True,
            "tables": False,
        },
        "limits": {
            "maxSyncImageSizeBytes": MAX_SYNC_IMAGE_SIZE_BYTES,
            "maxPdfPages": MAX_PDF_PAGES,
            "pdfBatchSize": PDF_BATCH_SIZE,
            "pdfRenderDpi": OCR_MODE_CONFIGS[DEFAULT_OCR_MODE].pdf_dpi,
        },
    }
