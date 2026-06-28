from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Any

import fitz

from .constants import MAX_PDF_PAGES, PDF_BATCH_SIZE
from .image import ocr_image_path_once
from .modes import DEFAULT_OCR_MODE, OCR_MODE_CONFIGS, OcrMode, normalize_ocr_mode
from .quality import aggregate_pdf_quality, evaluate_quality, quality_with_fallback_reasons
from .result_builder import attach_ocr_metadata, build_result
from .timings import add_timings, add_timings_in_place, elapsed_ms, empty_timings, finish_aggregate_timings
from .utils import safe_filename


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
