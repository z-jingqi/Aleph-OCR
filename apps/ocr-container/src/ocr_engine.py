from __future__ import annotations

import os
import re
import statistics
import tempfile
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import fitz
from paddleocr import PaddleOCR
from PIL import Image, ImageOps

try:
    import pillow_avif  # noqa: F401
except Exception:
    pillow_avif = None

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:
    pillow_heif = None

ENGINE = "paddleocr"
ENGINE_VERSION = "3.3.2"
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "100"))
PDF_BATCH_SIZE = int(os.getenv("PDF_BATCH_SIZE", "5"))
MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024
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


@dataclass(frozen=True)
class PreprocessedImage:
    path: Path
    width: int
    height: int
    preprocessed_width: int
    preprocessed_height: int
    decode_ms: float
    preprocess_ms: float


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


def ocr_image_bytes(content: bytes, filename: str, mime_type: str, mode: str = DEFAULT_OCR_MODE) -> dict[str, Any]:
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
        )


def ocr_pdf_bytes(content: bytes, filename: str, mime_type: str, mode: str = DEFAULT_OCR_MODE) -> dict[str, Any]:
    requested_mode = normalize_ocr_mode(mode)
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if doc.page_count > MAX_PDF_PAGES:
                raise ValueError(f"PDF has {doc.page_count} pages; max supported pages is {MAX_PDF_PAGES}")
            return ocr_pdf_document_range_with_fallback(doc, filename, mime_type, 0, doc.page_count, requested_mode, Path(tmpdir))
        finally:
            doc.close()


def pdf_info_bytes(content: bytes, filename: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if doc.page_count > MAX_PDF_PAGES:
                raise ValueError(f"PDF has {doc.page_count} pages; max supported pages is {MAX_PDF_PAGES}")
            return {"pageCount": doc.page_count}
        finally:
            doc.close()


def ocr_pdf_page_bytes(content: bytes, filename: str, page_index: int, mode: str = DEFAULT_OCR_MODE) -> dict[str, Any]:
    requested_mode = normalize_ocr_mode(mode)
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if page_index < 0 or page_index >= doc.page_count:
                raise ValueError(f"pageIndex {page_index} is outside PDF page range")
            return ocr_pdf_page_document_with_fallback(doc, filename, page_index, requested_mode, Path(tmpdir))
        finally:
            doc.close()


def ocr_pdf_batch_bytes(
    content: bytes,
    filename: str,
    mime_type: str,
    start_page: int,
    page_count: int,
    mode: str = DEFAULT_OCR_MODE,
) -> dict[str, Any]:
    requested_mode = normalize_ocr_mode(mode)
    if start_page < 0:
        raise ValueError("startPage must be greater than or equal to 0")
    if page_count < 1:
        raise ValueError("pageCount must be greater than or equal to 1")
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if doc.page_count > MAX_PDF_PAGES:
                raise ValueError(f"PDF has {doc.page_count} pages; max supported pages is {MAX_PDF_PAGES}")
            if start_page >= doc.page_count or start_page + page_count > doc.page_count:
                raise ValueError(f"page range {start_page}-{start_page + page_count - 1} is outside PDF page range")
            return ocr_pdf_document_range_with_fallback(doc, filename, mime_type, start_page, page_count, requested_mode, Path(tmpdir))
        finally:
            doc.close()


def ocr_pdf_document_range_with_fallback(
    doc: fitz.Document,
    filename: str,
    mime_type: str,
    start_page: int,
    page_count: int,
    requested_mode: OcrMode,
    tmpdir: Path,
) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    timings = empty_timings()
    fallback_used = False
    requested_total = 0.0
    fallback_total = 0.0
    for start in range(start_page, start_page + page_count, PDF_BATCH_SIZE):
        end = min(start + PDF_BATCH_SIZE, start_page + page_count)
        for page_index in range(start, end):
            page_result = ocr_pdf_page_document_with_fallback(doc, filename, page_index, requested_mode, tmpdir)
            pages.extend(page_result["pages"])
            fallback_used = fallback_used or bool(page_result.get("fallbackUsed"))
            add_timings_in_place(timings, page_result.get("timingsMs", {}))
            requested_total += float(page_result.get("timingsMs", {}).get("requestedTotal", 0))
            fallback_total += float(page_result.get("timingsMs", {}).get("fallbackTotal", 0))

    quality = aggregate_pdf_quality(pages)
    result = build_result(filename, mime_type, "pdf", pages)
    final_mode: OcrMode = "accurate" if fallback_used else requested_mode
    attach_ocr_metadata(
        result,
        ocr_mode=final_mode,
        requested_ocr_mode=requested_mode,
        fallback_used=fallback_used,
        quality=quality,
        timings=finish_aggregate_timings(timings, requested_total, fallback_total),
    )
    return result


def render_pdf_page(doc: fitz.Document, page_index: int, tmpdir: Path, mode: OcrMode) -> Path:
    config = OCR_MODE_CONFIGS[mode]
    page = doc.load_page(page_index)
    pix = page.get_pixmap(dpi=config.pdf_dpi, alpha=False)
    page_path = tmpdir / f"page-{page_index + 1}-{mode}-{config.pdf_dpi}dpi.png"
    pix.save(page_path)
    return page_path


def ocr_pdf_page_document_with_fallback(doc: fitz.Document, filename: str, page_index: int, requested_mode: OcrMode, tmpdir: Path) -> dict[str, Any]:
    started = time.perf_counter()
    page_path = render_pdf_page(doc, page_index, tmpdir, requested_mode)
    first = ocr_image_path_once(page_path, f"{filename}#page={page_index + 1}", "image/png", page_index, "pdf", requested_mode, tmpdir)
    first_quality = evaluate_quality(first["pages"])
    if requested_mode != "accurate" and first_quality["lowQuality"]:
        accurate_page_path = render_pdf_page(doc, page_index, tmpdir, "accurate")
        second = ocr_image_path_once(accurate_page_path, f"{filename}#page={page_index + 1}", "image/png", page_index, "pdf", "accurate", tmpdir)
        second_quality = evaluate_quality(second["pages"])
        timings = add_timings(first["timingsMs"], second["timingsMs"])
        timings["requestedTotal"] = first["timingsMs"]["total"]
        timings["fallbackTotal"] = second["timingsMs"]["total"]
        timings["total"] = elapsed_ms(started)
        attach_ocr_metadata(
            second,
            ocr_mode="accurate",
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


def ocr_image_path_with_fallback(
    image_path: Path,
    filename: str,
    mime_type: str,
    page_index: int,
    document_type: str,
    requested_mode: OcrMode,
    tmpdir: Path,
) -> dict[str, Any]:
    started = time.perf_counter()
    first = ocr_image_path_once(image_path, filename, mime_type, page_index, document_type, requested_mode, tmpdir)
    first_quality = evaluate_quality(first["pages"])
    if requested_mode != "accurate" and first_quality["lowQuality"]:
        second = ocr_image_path_once(image_path, filename, mime_type, page_index, document_type, "accurate", tmpdir)
        second_quality = evaluate_quality(second["pages"])
        timings = add_timings(first["timingsMs"], second["timingsMs"])
        timings["requestedTotal"] = first["timingsMs"]["total"]
        timings["fallbackTotal"] = second["timingsMs"]["total"]
        timings["total"] = elapsed_ms(started)
        attach_ocr_metadata(
            second,
            ocr_mode="accurate",
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
) -> dict[str, Any]:
    started = time.perf_counter()
    preprocessed = preprocess_image_path(image_path, tmpdir, mode, page_index)
    before_init = mode in _MODEL_INIT_MS
    ocr = get_ocr(mode)
    model_init_ms = 0.0 if before_init else _MODEL_INIT_MS.get(mode, 0.0)
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


def preprocess_image_path(image_path: Path, tmpdir: Path, mode: OcrMode, page_index: int) -> PreprocessedImage:
    config = OCR_MODE_CONFIGS[mode]
    return preprocess_image_for_ocr(image_path, tmpdir, config, suffix=f"{page_index + 1}-{mode}")


def preprocess_image_for_ocr(image_path: Path, tmpdir: Path, config: OcrModeConfig, suffix: str = "image") -> PreprocessedImage:
    decode_started = time.perf_counter()
    with Image.open(image_path) as original:
        original.load()
        original_width, original_height = original.size
        decode_ms = elapsed_ms(decode_started)
        preprocess_started = time.perf_counter()
        image = ImageOps.exif_transpose(original)
        if image.mode in {"RGBA", "LA", "P"}:
            image = composite_on_white(image)
        elif image.mode != "RGB":
            image = image.convert("RGB")
        image = resize_to_max_side(image, config.max_side)
        preprocessed_path = tmpdir / f"ocr-preprocessed-{suffix}.png"
        image.save(preprocessed_path, format="PNG", optimize=True)
        preprocessed_width, preprocessed_height = image.size
        preprocess_ms = elapsed_ms(preprocess_started)
    return PreprocessedImage(
        path=preprocessed_path,
        width=original_width,
        height=original_height,
        preprocessed_width=preprocessed_width,
        preprocessed_height=preprocessed_height,
        decode_ms=decode_ms,
        preprocess_ms=preprocess_ms,
    )


def composite_on_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    background.alpha_composite(rgba)
    return background.convert("RGB")


def resize_to_max_side(image: Image.Image, max_side: int) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_side:
        return image
    scale = max_side / longest
    target_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(target_size, Image.Resampling.LANCZOS)


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


def evaluate_quality(pages: list[dict[str, Any]]) -> dict[str, Any]:
    page_blocks: list[dict[str, Any]] = []
    for page in pages:
        blocks = page.get("blocks")
        if isinstance(blocks, list):
            page_blocks.extend(block for block in blocks if isinstance(block, dict))
    quality = evaluate_ocr_quality(page_blocks)
    quality["pageCount"] = len(pages)
    quality["lowQualityPageCount"] = 1 if quality["lowQuality"] and pages else 0
    return quality


def aggregate_pdf_quality(pages: list[dict[str, Any]]) -> dict[str, Any]:
    quality = evaluate_quality(pages)
    fallback_reasons: list[str] = list(quality.get("fallbackReasons") or quality.get("reasons") or [])
    page_quality_metadata_found = False
    low_quality_page_count = 0
    for page in pages:
        page_quality = page.get("quality")
        if not isinstance(page_quality, dict):
            continue
        page_quality_metadata_found = True
        initial_quality = page_quality.get("initial")
        page_reasons = [
            *string_list(page_quality.get("fallbackReasons")),
            *string_list(page_quality.get("reasons")),
            *(string_list(initial_quality.get("fallbackReasons")) if isinstance(initial_quality, dict) else []),
            *(string_list(initial_quality.get("reasons")) if isinstance(initial_quality, dict) else []),
        ]
        append_unique(fallback_reasons, page_reasons)
        if page_quality.get("lowQuality") is True or (isinstance(initial_quality, dict) and initial_quality.get("lowQuality") is True) or page_reasons:
            low_quality_page_count += 1

    quality["fallbackReasons"] = fallback_reasons
    if page_quality_metadata_found:
        quality["lowQualityPageCount"] = low_quality_page_count
    return quality


def evaluate_ocr_quality(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    text = "\n".join(str(block.get("text", "")) for block in blocks)
    compact_text = re.sub(r"\s+", "", text)
    confidence_values = [float(block["confidence"]) for block in blocks if isinstance(block.get("confidence"), (int, float))]
    average_confidence = statistics.fmean(confidence_values) if confidence_values else None
    reasons: list[str] = []
    if not blocks:
        reasons.append("no_blocks")
    if len(compact_text) < 20:
        reasons.append("short_text")
    if average_confidence is not None and average_confidence < 0.82:
        reasons.append("low_confidence")
    digit_count = len(re.findall(r"\d", compact_text))
    tableish_count = len(re.findall(r"[%:：/\\.,，+\-|]", compact_text))
    if (digit_count >= 3 or tableish_count >= 3) and len(compact_text) < 20:
        reasons.append("short_numeric_table")
    text_score = min(1.0, len(compact_text) / 80)
    confidence_score = average_confidence if average_confidence is not None else (0.0 if not blocks else 0.75)
    score = max(0.0, min(1.0, (text_score * 0.4) + (confidence_score * 0.6)))
    numeric_ratio = digit_count / len(compact_text) if compact_text else 0.0
    return {
        "score": round(score, 4),
        "lowQuality": bool(reasons),
        "reasons": reasons,
        "fallbackReasons": reasons,
        "blockCount": len(blocks),
        "validTextLength": len(compact_text),
        "effectiveTextLength": len(compact_text),
        "avgConfidence": round(average_confidence, 4) if average_confidence is not None else None,
        "averageConfidence": round(average_confidence, 4) if average_confidence is not None else None,
        "numericRatio": round(numeric_ratio, 4),
        "tableNumericLike": digit_count >= 3 or tableish_count >= 3,
    }


def quality_with_fallback_reasons(final_quality: dict[str, Any], initial_quality: dict[str, Any]) -> dict[str, Any]:
    initial_reasons = initial_quality.get("fallbackReasons") or initial_quality.get("reasons") or []
    return {
        **final_quality,
        "fallbackReasons": list(initial_reasons) if isinstance(initial_reasons, list) else [],
        "initial": initial_quality,
    }


def string_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def empty_timings() -> dict[str, float]:
    return {"decode": 0.0, "preprocess": 0.0, "modelInit": 0.0, "ocr": 0.0, "normalize": 0.0, "total": 0.0}


def add_timings(left: dict[str, Any], right: dict[str, Any]) -> dict[str, float]:
    merged = empty_timings()
    for key in set(merged) | set(left) | set(right):
        left_value = left.get(key, 0)
        right_value = right.get(key, 0)
        if isinstance(left_value, (int, float)) and isinstance(right_value, (int, float)):
            merged[key] = float(left_value) + float(right_value)
    return merged


def add_timings_in_place(target: dict[str, float], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, (int, float)):
            target[key] = target.get(key, 0.0) + float(value)


def finish_aggregate_timings(timings: dict[str, float], requested_total: float, fallback_total: float) -> dict[str, float]:
    total = timings.get("decode", 0.0) + timings.get("preprocess", 0.0) + timings.get("modelInit", 0.0) + timings.get("ocr", 0.0) + timings.get("normalize", 0.0)
    timings["total"] = total
    timings["requestedTotal"] = requested_total
    timings["fallbackTotal"] = fallback_total
    return timings


def normalize_blocks(raw: Any) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for item in flatten_ocr_items(raw):
        if isinstance(item, dict):
            blocks.extend(parse_paddle_v3_result(item))
        else:
            parsed = parse_ocr_item(item)
            if parsed:
                blocks.append(parsed)
    return blocks


def flatten_ocr_items(raw: Any):
    if raw is None:
        return
    if isinstance(raw, dict):
        yield raw
        return
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict) or looks_like_ocr_line(item):
                yield item
            else:
                yield from flatten_ocr_items(item)


def looks_like_ocr_line(item: Any) -> bool:
    return isinstance(item, list) and len(item) >= 2 and isinstance(item[1], (list, tuple)) and len(item[1]) >= 1 and isinstance(item[1][0], str)


def parse_ocr_item(item: Any) -> dict[str, Any] | None:
    try:
        bbox = item[0]
        text = item[1][0]
        confidence = float(item[1][1]) if len(item[1]) > 1 and item[1][1] is not None else None
        return {"text": text, "bbox": flatten_bbox(bbox), "confidence": confidence}
    except Exception:
        return None


def parse_paddle_v3_result(item: dict[str, Any]) -> list[dict[str, Any]]:
    texts = item.get("rec_texts")
    if not isinstance(texts, list):
        return []
    scores = item.get("rec_scores") if isinstance(item.get("rec_scores"), list) else []
    polygons = item.get("rec_polys") if isinstance(item.get("rec_polys"), list) else item.get("dt_polys")
    polygons = polygons if isinstance(polygons, list) else []

    blocks: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        if not isinstance(text, str) or not text:
            continue
        confidence = None
        if index < len(scores) and scores[index] is not None:
            try:
                confidence = float(scores[index])
            except (TypeError, ValueError):
                confidence = None
        bbox = flatten_bbox(polygons[index]) if index < len(polygons) else []
        blocks.append({"text": text, "bbox": bbox, "confidence": confidence})
    return blocks


def flatten_bbox(bbox: Any) -> list[float]:
    values: list[float] = []
    if hasattr(bbox, "tolist"):
        bbox = bbox.tolist()
    if isinstance(bbox, (list, tuple)):
        for point in bbox:
            if isinstance(point, (list, tuple)):
                values.extend(float(v) for v in point[:2])
            elif isinstance(point, (int, float)):
                values.append(float(point))
    return values


def safe_filename(filename: str, fallback: str) -> str:
    value = Path(filename or fallback).name
    return value or fallback


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000
