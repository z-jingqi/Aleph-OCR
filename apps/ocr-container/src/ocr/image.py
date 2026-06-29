from __future__ import annotations

import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

from .modes import DEFAULT_OCR_MODE, FALLBACK_OCR_MODE, OcrMode, get_ocr, model_init_ms_for_request, normalize_ocr_mode
from .normalize import normalize_blocks
from .preprocess import preprocess_image_path
from .quality import evaluate_quality, quality_with_fallback_reasons
from .result_builder import attach_ocr_metadata, build_result
from .timings import add_timings, elapsed_ms
from .utils import safe_filename


def ocr_image_bytes(
    content: bytes,
    filename: str,
    mime_type: str,
    mode: str = DEFAULT_OCR_MODE,
    max_side: int | None = None,
    document_crop: bool = False,
) -> dict[str, Any]:
    normalized_mode = normalize_ocr_mode(mode)
    with tempfile.TemporaryDirectory() as tmpdir:
        image_path = Path(tmpdir) / safe_filename(filename, "image")
        image_path.write_bytes(content)
        return ocr_image_path_with_fallback(
            image_path,
            filename,
            mime_type,
            page_index=0,
            document_type="image",
            requested_mode=normalized_mode,
            tmpdir=Path(tmpdir),
            max_side=max_side,
            document_crop=document_crop,
        )


def ocr_image_path_with_fallback(
    image_path: Path,
    filename: str,
    mime_type: str,
    page_index: int,
    document_type: str,
    requested_mode: OcrMode,
    tmpdir: Path,
    max_side: int | None = None,
    document_crop: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    first = ocr_image_path_once(image_path, filename, mime_type, page_index, document_type, requested_mode, tmpdir, max_side=max_side, document_crop=document_crop)
    first_quality = evaluate_quality(first["pages"])
    if requested_mode != FALLBACK_OCR_MODE and first_quality["lowQuality"]:
        second = ocr_image_path_once(image_path, filename, mime_type, page_index, document_type, FALLBACK_OCR_MODE, tmpdir, max_side=max_side, document_crop=document_crop)
        second_quality = evaluate_quality(second["pages"])
        timings = add_timings(first["timingsMs"], second["timingsMs"])
        timings["requestedTotal"] = first["timingsMs"]["total"]
        timings["fallbackTotal"] = second["timingsMs"]["total"]
        timings["total"] = elapsed_ms(started)
        attach_ocr_metadata(
            second,
            ocr_mode=FALLBACK_OCR_MODE,
            requested_ocr_mode=requested_mode,
            fallback_used=True,
            quality=quality_with_fallback_reasons(second_quality, first_quality),
            timings=timings,
        )
        return second

    timings = first["timingsMs"]
    timings["requestedTotal"] = timings["total"]
    timings["fallbackTotal"] = 0.0
    timings["total"] = elapsed_ms(started)
    attach_ocr_metadata(first, ocr_mode=requested_mode, requested_ocr_mode=requested_mode, fallback_used=False, quality=first_quality, timings=timings)
    return first


def ocr_image_path_once(
    image_path: Path,
    filename: str,
    mime_type: str,
    page_index: int,
    document_type: str,
    mode: OcrMode,
    tmpdir: Path,
    max_side: int | None = None,
    document_crop: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    preprocessed = preprocess_image_path(image_path, tmpdir, mode, page_index, max_side=max_side, document_crop=document_crop)
    before_init, cached_model_init_ms = model_init_ms_for_request(mode)
    ocr = get_ocr(mode)
    model_init_ms = 0.0 if before_init else model_init_ms_for_request(mode)[1] or cached_model_init_ms
    ocr_started = time.perf_counter()
    raw = ocr.ocr(str(preprocessed.path))
    ocr_ms = elapsed_ms(ocr_started)
    normalize_started = time.perf_counter()
    blocks = normalize_blocks(raw)
    text = "\n".join(block["text"] for block in blocks if block["text"])
    confidence_values = [block["confidence"] for block in blocks if block.get("confidence") is not None]
    confidence = statistics.fmean(confidence_values) if confidence_values else None
    normalize_ms = elapsed_ms(normalize_started)
    page = {
        "pageIndex": page_index,
        "width": preprocessed.preprocessed_width,
        "height": preprocessed.preprocessed_height,
        "text": text,
        "blocks": blocks,
        "tables": [],
        "confidence": confidence,
        "ocrMode": mode,
        "preprocessedWidth": preprocessed.preprocessed_width,
        "preprocessedHeight": preprocessed.preprocessed_height,
        "ocrInputMaxSide": preprocessed.max_side,
        "documentCropApplied": preprocessed.crop_applied,
        **({"documentCropBbox": list(preprocessed.crop_bbox)} if preprocessed.crop_bbox else {}),
    }
    result = build_result(filename, mime_type, document_type, [page])
    result["timingsMs"] = {
        "decode": preprocessed.decode_ms,
        "preprocess": preprocessed.preprocess_ms,
        "modelInit": model_init_ms,
        "ocr": ocr_ms,
        "normalize": normalize_ms,
        "total": elapsed_ms(started),
    }
    return result
