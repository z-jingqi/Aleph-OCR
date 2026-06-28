from __future__ import annotations

from typing import Any

try:
    import pillow_avif  # noqa: F401
except Exception:
    pillow_avif = None

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:
    pillow_heif = None

try:
    from .ocr import image as _image  # noqa: E402
    from .ocr import modes as _modes  # noqa: E402
    from .ocr import pdf as _pdf  # noqa: E402
    from .ocr import (  # noqa: E402,F401
        DEFAULT_OCR_MODE,
        MODE_CONFIGS,
        OCR_MODE_CONFIGS,
        OCR_MODES,
        SUPPORTED_OCR_MODES,
        OcrMode,
        OcrModeConfig,
        engine_info,
        normalize_ocr_mode,
    )
    from .ocr.normalize import (  # noqa: E402,F401
        flatten_bbox,
        flatten_ocr_items,
        looks_like_ocr_line,
        normalize_blocks,
        parse_ocr_item,
        parse_paddle_v3_result,
    )
    from .ocr.preprocess import (  # noqa: E402,F401
        PreprocessedImage,
        composite_on_white,
        preprocess_image_for_ocr,
        preprocess_image_path,
        resize_to_max_side,
    )
    from .ocr.quality import (  # noqa: E402,F401
        aggregate_pdf_quality,
        append_unique,
        evaluate_ocr_quality,
        evaluate_quality,
        quality_with_fallback_reasons,
        string_list,
    )
    from .ocr.result_builder import attach_ocr_metadata, build_result  # noqa: E402,F401
    from .ocr.timings import (  # noqa: E402,F401
        add_timings,
        add_timings_in_place,
        elapsed_ms,
        empty_timings,
        finish_aggregate_timings,
    )
    from .ocr.utils import safe_filename  # noqa: E402,F401
except ImportError:
    from ocr import image as _image  # type: ignore[no-redef] # noqa: E402
    from ocr import modes as _modes  # type: ignore[no-redef] # noqa: E402
    from ocr import pdf as _pdf  # type: ignore[no-redef] # noqa: E402
    from ocr import (  # type: ignore[no-redef] # noqa: E402,F401
        DEFAULT_OCR_MODE,
        MODE_CONFIGS,
        OCR_MODE_CONFIGS,
        OCR_MODES,
        SUPPORTED_OCR_MODES,
        OcrMode,
        OcrModeConfig,
        engine_info,
        normalize_ocr_mode,
    )
    from ocr.normalize import (  # type: ignore[no-redef] # noqa: E402,F401
        flatten_bbox,
        flatten_ocr_items,
        looks_like_ocr_line,
        normalize_blocks,
        parse_ocr_item,
        parse_paddle_v3_result,
    )
    from ocr.preprocess import (  # type: ignore[no-redef] # noqa: E402,F401
        PreprocessedImage,
        composite_on_white,
        preprocess_image_for_ocr,
        preprocess_image_path,
        resize_to_max_side,
    )
    from ocr.quality import (  # type: ignore[no-redef] # noqa: E402,F401
        aggregate_pdf_quality,
        append_unique,
        evaluate_ocr_quality,
        evaluate_quality,
        quality_with_fallback_reasons,
        string_list,
    )
    from ocr.result_builder import attach_ocr_metadata, build_result  # type: ignore[no-redef] # noqa: E402,F401
    from ocr.timings import (  # type: ignore[no-redef] # noqa: E402,F401
        add_timings,
        add_timings_in_place,
        elapsed_ms,
        empty_timings,
        finish_aggregate_timings,
    )
    from ocr.utils import safe_filename  # type: ignore[no-redef] # noqa: E402,F401

PaddleOCR = _modes.PaddleOCR
fitz = _pdf.fitz


def _sync_compat_test_doubles() -> None:
    _modes.PaddleOCR = PaddleOCR
    _pdf.fitz = fitz


def clear_ocr_cache() -> None:
    _sync_compat_test_doubles()
    _modes.clear_ocr_cache()


def get_ocr(mode: str = DEFAULT_OCR_MODE) -> Any:
    _sync_compat_test_doubles()
    return _modes.get_ocr(mode)


get_ocr.cache_clear = clear_ocr_cache  # type: ignore[attr-defined]


def preload_ocr(mode: str = DEFAULT_OCR_MODE) -> None:
    _sync_compat_test_doubles()
    _modes.preload_ocr(mode)


def ocr_image_bytes(content: bytes, filename: str, mime_type: str, mode: str = DEFAULT_OCR_MODE) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _image.ocr_image_bytes(content, filename, mime_type, mode)


def ocr_image_path_once(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _image.ocr_image_path_once(*args, **kwargs)


def ocr_image_path_with_fallback(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _image.ocr_image_path_with_fallback(*args, **kwargs)


def ocr_pdf_batch_bytes(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.ocr_pdf_batch_bytes(*args, **kwargs)


def ocr_pdf_bytes(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.ocr_pdf_bytes(*args, **kwargs)


def ocr_pdf_document_range_with_fallback(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.ocr_pdf_document_range_with_fallback(*args, **kwargs)


def ocr_pdf_page_bytes(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.ocr_pdf_page_bytes(*args, **kwargs)


def ocr_pdf_page_document_with_fallback(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.ocr_pdf_page_document_with_fallback(*args, **kwargs)


def pdf_info_bytes(*args: Any, **kwargs: Any) -> dict[str, Any]:
    _sync_compat_test_doubles()
    return _pdf.pdf_info_bytes(*args, **kwargs)


def render_pdf_page(*args: Any, **kwargs: Any) -> Any:
    _sync_compat_test_doubles()
    return _pdf.render_pdf_page(*args, **kwargs)


__all__ = [
    "DEFAULT_OCR_MODE",
    "MODE_CONFIGS",
    "OCR_MODE_CONFIGS",
    "OCR_MODES",
    "SUPPORTED_OCR_MODES",
    "OcrMode",
    "OcrModeConfig",
    "PreprocessedImage",
    "PaddleOCR",
    "add_timings",
    "add_timings_in_place",
    "aggregate_pdf_quality",
    "append_unique",
    "attach_ocr_metadata",
    "build_result",
    "clear_ocr_cache",
    "composite_on_white",
    "elapsed_ms",
    "empty_timings",
    "engine_info",
    "evaluate_ocr_quality",
    "evaluate_quality",
    "finish_aggregate_timings",
    "fitz",
    "flatten_bbox",
    "flatten_ocr_items",
    "get_ocr",
    "looks_like_ocr_line",
    "normalize_blocks",
    "normalize_ocr_mode",
    "ocr_image_bytes",
    "ocr_image_path_once",
    "ocr_image_path_with_fallback",
    "ocr_pdf_batch_bytes",
    "ocr_pdf_bytes",
    "ocr_pdf_document_range_with_fallback",
    "ocr_pdf_page_bytes",
    "ocr_pdf_page_document_with_fallback",
    "parse_ocr_item",
    "parse_paddle_v3_result",
    "pdf_info_bytes",
    "preload_ocr",
    "preprocess_image_for_ocr",
    "preprocess_image_path",
    "quality_with_fallback_reasons",
    "render_pdf_page",
    "resize_to_max_side",
    "safe_filename",
    "string_list",
]
