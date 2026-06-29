from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Any

import fitz

from .constants import MAX_PDF_PAGES, PDF_BATCH_SIZE
from .image import ocr_image_path_once
from .modes import DEFAULT_OCR_MODE, FALLBACK_OCR_MODE, OCR_MODE_CONFIGS, OcrMode, normalize_ocr_mode
from .quality import aggregate_pdf_quality, evaluate_quality, quality_with_fallback_reasons
from .result_builder import attach_ocr_metadata, build_result
from .timings import add_timings, add_timings_in_place, elapsed_ms, empty_timings, finish_aggregate_timings
from .utils import safe_filename

TEXT_LAYER_MIN_LENGTH = 20


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
            return {"pageCount": doc.page_count, "pages": pdf_text_layer_summaries(doc)}
        finally:
            doc.close()


def pdf_text_batch_bytes(
    content: bytes,
    filename: str,
    mime_type: str,
    start_page: int,
    page_count: int,
) -> dict[str, Any]:
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
            return pdf_text_document_range(doc, filename, mime_type, start_page, page_count)
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
    final_mode: OcrMode = FALLBACK_OCR_MODE if fallback_used else requested_mode
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
    if requested_mode != FALLBACK_OCR_MODE and first_quality["lowQuality"]:
        fallback_page_path = render_pdf_page(doc, page_index, tmpdir, FALLBACK_OCR_MODE)
        second = ocr_image_path_once(fallback_page_path, f"{filename}#page={page_index + 1}", "image/png", page_index, "pdf", FALLBACK_OCR_MODE, tmpdir)
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


def pdf_text_layer_summaries(doc: fitz.Document) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for page_index in range(doc.page_count):
        text = extract_page_text(doc.load_page(page_index))
        text_length = effective_text_length(text)
        summaries.append({
            "pageIndex": page_index,
            "hasTextLayer": text_length >= TEXT_LAYER_MIN_LENGTH,
            "textLength": text_length,
        })
    return summaries


def pdf_text_document_range(doc: fitz.Document, filename: str, mime_type: str, start_page: int, page_count: int) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    timings = empty_timings()
    for page_index in range(start_page, start_page + page_count):
        page_result = extract_pdf_text_page(doc, page_index)
        pages.append(page_result)
        add_timings_in_place(timings, page_result.get("timingsMs", {}))
    result = build_result(filename, mime_type, "pdf", pages)
    timings["total"] = timings.get("extractText", 0.0)
    rounded_timings = {key: round(float(value), 3) for key, value in timings.items()}
    result["extractionMethod"] = "pdf_text"
    result["timingsMs"] = rounded_timings
    result["metadata"] = {
        **(result.get("metadata") or {}),
        "extractionMethod": "pdf_text",
        "timingsMs": rounded_timings,
    }
    return result


def extract_pdf_text_page(doc: fitz.Document, page_index: int) -> dict[str, Any]:
    started = time.perf_counter()
    page = doc.load_page(page_index)
    text = extract_page_text(page)
    blocks = extract_text_blocks(page)
    width, height = page_size(page)
    timing = round(elapsed_ms(started), 3)
    return {
        "pageIndex": page_index,
        "width": width,
        "height": height,
        "text": text,
        "blocks": blocks,
        "tables": [],
        "confidence": None,
        "extractionMethod": "pdf_text",
        "timingsMs": {
            "extractText": timing,
            "total": timing,
        },
    }


def extract_page_text(page: fitz.Page) -> str:
    text = page.get_text("text")
    return text.strip() if isinstance(text, str) else ""


def extract_text_blocks(page: fitz.Page) -> list[dict[str, Any]]:
    try:
        page_dict = page.get_text("dict")
    except Exception:
        page_dict = None
    blocks: list[dict[str, Any]] = []
    if isinstance(page_dict, dict):
        for block in page_dict.get("blocks", []):
            if not isinstance(block, dict):
                continue
            for line in block.get("lines", []):
                if not isinstance(line, dict):
                    continue
                line_text_parts: list[str] = []
                line_bbox: list[float] = []
                for span in line.get("spans", []):
                    if not isinstance(span, dict):
                        continue
                    span_text = span.get("text")
                    if isinstance(span_text, str):
                        line_text_parts.append(span_text)
                    if not line_bbox and isinstance(span.get("bbox"), (list, tuple)):
                        line_bbox = [float(value) for value in span["bbox"][:4]]
                line_text = "".join(line_text_parts).strip()
                if line_text:
                    blocks.append({"text": line_text, "bbox": line_bbox, "confidence": None})
    if blocks:
        return blocks
    return [{"text": line, "confidence": None} for line in extract_page_text(page).splitlines() if line.strip()]


def page_size(page: fitz.Page) -> tuple[float, float]:
    rect = getattr(page, "rect", None)
    width = float(getattr(rect, "width", 0) or 0)
    height = float(getattr(rect, "height", 0) or 0)
    return width, height


def effective_text_length(text: str) -> int:
    return len("".join(text.split()))
