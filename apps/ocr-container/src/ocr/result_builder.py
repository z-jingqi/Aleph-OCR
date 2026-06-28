from __future__ import annotations

from typing import Any

from .constants import ENGINE, ENGINE_VERSION
from .modes import OcrMode


def build_result(filename: str, mime_type: str, document_type: str, pages: list[dict[str, Any]]) -> dict[str, Any]:
    plain_text = "\n\n".join(page["text"] for page in pages if page["text"])
    markdown = "\n\n".join(f"## Page {page['pageIndex'] + 1}\n\n{page['text']}" for page in pages if page["text"])
    return {
        "status": "ready",
        "engine": ENGINE,
        "engineVersion": ENGINE_VERSION,
        "document": {"type": document_type, "filename": filename, "mimeType": mime_type},
        "pages": pages,
        "plainText": plain_text,
        "markdown": markdown,
    }


def attach_ocr_metadata(
    result: dict[str, Any],
    ocr_mode: OcrMode,
    requested_ocr_mode: OcrMode,
    fallback_used: bool,
    quality: dict[str, Any],
    timings: dict[str, float],
) -> None:
    rounded_timings = {key: round(float(value), 3) for key, value in timings.items()}
    result["ocrMode"] = ocr_mode
    result["requestedOcrMode"] = requested_ocr_mode
    result["fallbackUsed"] = fallback_used
    result["quality"] = quality
    result["timingsMs"] = rounded_timings
    for page in result.get("pages", []):
        if isinstance(page, dict):
            page.setdefault("ocrMode", ocr_mode)
            page.setdefault("requestedOcrMode", requested_ocr_mode)
            page.setdefault("fallbackUsed", fallback_used)
            page.setdefault("quality", quality)
            page.setdefault("timingsMs", rounded_timings)
    result["metadata"] = {
        **(result.get("metadata") or {}),
        "ocrMode": ocr_mode,
        "requestedOcrMode": requested_ocr_mode,
        "fallbackUsed": fallback_used,
        "quality": quality,
        "timingsMs": rounded_timings,
    }
