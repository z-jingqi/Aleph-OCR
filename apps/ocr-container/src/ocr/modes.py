from __future__ import annotations

import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

from paddleocr import PaddleOCR

from .timings import elapsed_ms

OcrMode = Literal["fast", "balanced", "accurate"]
DEFAULT_OCR_MODE: OcrMode = "balanced"
SUPPORTED_OCR_MODES: tuple[OcrMode, ...] = ("fast", "balanced", "accurate")


@dataclass(frozen=True)
class OcrModeConfig:
    mode: OcrMode
    text_detection_model_name: str
    text_recognition_model_name: str
    max_side: int
    pdf_dpi: int
    use_doc_orientation_classify: bool
    use_doc_unwarping: bool
    use_textline_orientation: bool
    doc_orientation_classify_model_name: str | None = None
    doc_unwarping_model_name: str | None = None
    textline_orientation_model_name: str | None = None

    @property
    def preprocess_max_side(self) -> int:
        return self.max_side

    @property
    def pdf_render_dpi(self) -> int:
        return self.pdf_dpi

    def public(self) -> dict[str, Any]:
        return {
            "textDetectionModel": self.text_detection_model_name,
            "textRecognitionModel": self.text_recognition_model_name,
            "maxSide": self.max_side,
            "pdfDpi": self.pdf_dpi,
            "preprocessMaxSide": self.max_side,
            "pdfRenderDpi": self.pdf_dpi,
            "docOrientation": self.use_doc_orientation_classify,
            "docUnwarping": self.use_doc_unwarping,
            "textlineOrientation": self.use_textline_orientation,
        }


OCR_MODE_CONFIGS: dict[OcrMode, OcrModeConfig] = {
    "fast": OcrModeConfig(
        mode="fast",
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        max_side=1800,
        pdf_dpi=150,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    ),
    "balanced": OcrModeConfig(
        mode="balanced",
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_server_rec",
        max_side=2200,
        pdf_dpi=180,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    ),
    "accurate": OcrModeConfig(
        mode="accurate",
        text_detection_model_name="PP-OCRv5_server_det",
        text_recognition_model_name="PP-OCRv5_server_rec",
        max_side=3200,
        pdf_dpi=220,
        use_doc_orientation_classify=True,
        use_doc_unwarping=True,
        use_textline_orientation=True,
        doc_orientation_classify_model_name="PP-LCNet_x1_0_doc_ori",
        doc_unwarping_model_name="UVDoc",
        textline_orientation_model_name="PP-LCNet_x1_0_textline_ori",
    ),
}

OCR_MODES = SUPPORTED_OCR_MODES
MODE_CONFIGS = OCR_MODE_CONFIGS
_MODEL_INIT_MS: dict[OcrMode, float] = {}


def normalize_ocr_mode(mode: str | None) -> OcrMode:
    value = (mode or DEFAULT_OCR_MODE).strip().lower()
    if value not in OCR_MODE_CONFIGS:
        raise ValueError("mode must be one of fast, balanced, accurate")
    return value  # type: ignore[return-value]


def get_ocr(mode: str = DEFAULT_OCR_MODE) -> PaddleOCR:
    return _get_ocr(normalize_ocr_mode(mode))


@lru_cache(maxsize=len(SUPPORTED_OCR_MODES))
def _get_ocr(normalized: OcrMode) -> PaddleOCR:
    config = OCR_MODE_CONFIGS[normalized]
    started = time.perf_counter()
    try:
        return PaddleOCR(
            lang=os.getenv("PADDLEOCR_LANG", "ch"),
            text_detection_model_name=config.text_detection_model_name,
            text_recognition_model_name=config.text_recognition_model_name,
            doc_orientation_classify_model_name=config.doc_orientation_classify_model_name,
            doc_unwarping_model_name=config.doc_unwarping_model_name,
            textline_orientation_model_name=config.textline_orientation_model_name,
            use_doc_orientation_classify=config.use_doc_orientation_classify,
            use_doc_unwarping=config.use_doc_unwarping,
            use_textline_orientation=config.use_textline_orientation,
            text_det_limit_side_len=config.max_side,
            text_det_limit_type="max",
        )
    finally:
        _MODEL_INIT_MS[normalized] = elapsed_ms(started)


def clear_ocr_cache() -> None:
    _get_ocr.cache_clear()
    _MODEL_INIT_MS.clear()


get_ocr.cache_clear = clear_ocr_cache  # type: ignore[attr-defined]


def preload_ocr(mode: str = DEFAULT_OCR_MODE) -> None:
    get_ocr(mode)


def model_init_ms_for_request(mode: OcrMode) -> tuple[bool, float]:
    was_cached = mode in _MODEL_INIT_MS
    return was_cached, _MODEL_INIT_MS.get(mode, 0.0)
