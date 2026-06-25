from __future__ import annotations

import os
import statistics
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

import fitz
from paddleocr import PaddleOCR
from PIL import Image

ENGINE = "paddleocr"
ENGINE_VERSION = "3.x"
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "100"))
PDF_BATCH_SIZE = int(os.getenv("PDF_BATCH_SIZE", "5"))
PDF_RENDER_DPI = int(os.getenv("PDF_RENDER_DPI", "200"))


@lru_cache(maxsize=1)
def get_ocr() -> PaddleOCR:
    return PaddleOCR(lang=os.getenv("PADDLEOCR_LANG", "ch"))


def engine_info() -> dict[str, Any]:
    return {
        "engine": ENGINE,
        "engineVersion": ENGINE_VERSION,
        "capabilities": {
            "image": True,
            "pdf": True,
            "syncImage": True,
            "asyncJobs": True,
            "layout": True,
            "tables": False,
        },
        "limits": {
            "maxSyncImageSizeBytes": 10 * 1024 * 1024,
            "maxPdfPages": MAX_PDF_PAGES,
            "pdfBatchSize": PDF_BATCH_SIZE,
            "pdfRenderDpi": PDF_RENDER_DPI,
        },
    }


def ocr_image_bytes(content: bytes, filename: str, mime_type: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmpdir:
        image_path = Path(tmpdir) / safe_filename(filename, "image")
        image_path.write_bytes(content)
        return ocr_image_path(image_path, filename, mime_type, page_index=0, document_type="image")


def ocr_pdf_bytes(content: bytes, filename: str, mime_type: str) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if doc.page_count > MAX_PDF_PAGES:
                raise ValueError(f"PDF has {doc.page_count} pages; max supported pages is {MAX_PDF_PAGES}")
            for start in range(0, doc.page_count, PDF_BATCH_SIZE):
                end = min(start + PDF_BATCH_SIZE, doc.page_count)
                for page_index in range(start, end):
                    page = doc.load_page(page_index)
                    pix = page.get_pixmap(dpi=PDF_RENDER_DPI, alpha=False)
                    page_path = Path(tmpdir) / f"page-{page_index + 1}.png"
                    pix.save(page_path)
                    page_result = ocr_image_path(
                        page_path,
                        f"{filename}#page={page_index + 1}",
                        "image/png",
                        page_index=page_index,
                        document_type="pdf",
                    )
                    pages.extend(page_result["pages"])
        finally:
            doc.close()
    return build_result(filename, mime_type, "pdf", pages)


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


def ocr_pdf_page_bytes(content: bytes, filename: str, page_index: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / safe_filename(filename, "document.pdf")
        pdf_path.write_bytes(content)
        doc = fitz.open(pdf_path)
        try:
            if page_index < 0 or page_index >= doc.page_count:
                raise ValueError(f"pageIndex {page_index} is outside PDF page range")
            page = doc.load_page(page_index)
            pix = page.get_pixmap(dpi=PDF_RENDER_DPI, alpha=False)
            page_path = Path(tmpdir) / f"page-{page_index + 1}.png"
            pix.save(page_path)
            return ocr_image_path(page_path, f"{filename}#page={page_index + 1}", "image/png", page_index, "pdf")
        finally:
            doc.close()


def ocr_image_path(image_path: Path, filename: str, mime_type: str, page_index: int, document_type: str) -> dict[str, Any]:
    raw = get_ocr().ocr(str(image_path))
    blocks = normalize_blocks(raw)
    text = "\n".join(block["text"] for block in blocks if block["text"])
    confidence_values = [block["confidence"] for block in blocks if block.get("confidence") is not None]
    confidence = statistics.fmean(confidence_values) if confidence_values else None
    with Image.open(image_path) as image:
        width, height = image.size
    page = {
        "pageIndex": page_index,
        "width": width,
        "height": height,
        "text": text,
        "blocks": blocks,
        "tables": [],
        "confidence": confidence,
    }
    return build_result(filename, mime_type, document_type, [page])


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
