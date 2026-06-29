from __future__ import annotations

import io
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

from PIL import Image

fake_paddleocr = types.ModuleType("paddleocr")


class PlaceholderPaddleOCR:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs

    def ocr(self, path: str) -> list[Any]:
        return []


fake_paddleocr.PaddleOCR = PlaceholderPaddleOCR
sys.modules["paddleocr"] = fake_paddleocr

if "fitz" not in sys.modules:
    fake_fitz = types.ModuleType("fitz")
    fake_fitz.Page = object
    fake_fitz.open = lambda *_args, **_kwargs: None
    sys.modules["fitz"] = fake_fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.ocr import clear_ocr_cache, engine_info, get_ocr, ocr_image_bytes, ocr_pdf_batch_bytes, pdf_info_bytes, pdf_text_batch_bytes  # noqa: E402
from src.ocr import modes as ocr_modes  # noqa: E402
from src.ocr import pdf as ocr_pdf  # noqa: E402
from src.ocr.preprocess import preprocess_image_for_ocr  # noqa: E402
from src.ocr.quality import evaluate_ocr_quality  # noqa: E402


def make_line(text: str, confidence: float) -> list[Any]:
    return [[[0, 0], [120, 0], [120, 24], [0, 24]], [text, confidence]]


def make_png(width: int = 1200, height: int = 800, mode: str = "RGBA") -> bytes:
    color = (255, 255, 255, 255) if mode == "RGBA" else (255, 255, 255)
    image = Image.new(mode, (width, height), color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakeRect:
    width = 612
    height = 792


class FakePdfPage:
    def __init__(self, page_index: int, rendered_dpis: list[int], text_by_page: list[str] | None = None) -> None:
        self.page_index = page_index
        self.rendered_dpis = rendered_dpis
        self.text_by_page = text_by_page or []
        self.rect = FakeRect()

    def get_pixmap(self, dpi: int, alpha: bool) -> "FakePixmap":
        assert alpha is False
        self.rendered_dpis.append(dpi)
        return FakePixmap()

    def get_text(self, mode: str) -> Any:
        text = self.text_by_page[self.page_index] if self.page_index < len(self.text_by_page) else ""
        if mode == "text":
            return text
        if mode == "dict":
            lines = []
            for index, line in enumerate(text.splitlines()):
                lines.append({"spans": [{"text": line, "bbox": [0, index * 20, 200, index * 20 + 12]}]})
            return {"blocks": [{"lines": lines}]}
        return text


class FakePixmap:
    def save(self, path: Path) -> None:
        path.write_bytes(make_png(width=800, height=600, mode="RGB"))


class FakePdfDoc:
    def __init__(self, page_count: int, rendered_dpis: list[int], text_by_page: list[str] | None = None) -> None:
        self.page_count = page_count
        self.rendered_dpis = rendered_dpis
        self.text_by_page = text_by_page

    def load_page(self, page_index: int) -> FakePdfPage:
        return FakePdfPage(page_index, self.rendered_dpis, self.text_by_page)

    def close(self) -> None:
        pass


def test_model_source_check_env_is_configured() -> None:
    app_dir = Path(__file__).resolve().parents[1]
    dockerfile = (app_dir / "Dockerfile").read_text()
    download_script = (app_dir / "scripts" / "download-models.sh").read_text()

    assert "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True" in dockerfile
    assert "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK" in download_script


def test_mode_config_and_cache() -> None:
    created: list[dict[str, Any]] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            created.append(kwargs)

        def ocr(self, path: str) -> list[Any]:
            return []

    ocr_modes.PaddleOCR = FakePaddleOCR
    clear_ocr_cache()

    tiny_a = get_ocr("TINY")
    tiny_b = get_ocr("tiny")
    small = get_ocr("small")
    medium = get_ocr("medium")

    assert tiny_a is tiny_b
    assert small is not tiny_a
    assert medium is not small
    assert created[0]["text_detection_model_name"] == "PP-OCRv6_tiny_det"
    assert created[0]["text_recognition_model_name"] == "PP-OCRv6_tiny_rec"
    assert created[0]["use_doc_orientation_classify"] is False
    assert created[1]["text_detection_model_name"] == "PP-OCRv6_small_det"
    assert created[1]["text_recognition_model_name"] == "PP-OCRv6_small_rec"
    assert created[2]["text_detection_model_name"] == "PP-OCRv6_medium_det"
    assert created[2]["text_recognition_model_name"] == "PP-OCRv6_medium_rec"
    assert created[2]["use_doc_orientation_classify"] is True
    assert created[2]["use_doc_unwarping"] is True
    assert created[2]["use_textline_orientation"] is True


def test_preprocess_scales_and_normalizes_rgb() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        source = Path(tmpdir) / "large.png"
        source.write_bytes(make_png(width=2400, height=1200, mode="RGBA"))
        preprocessed = preprocess_image_for_ocr(source, Path(tmpdir), ocr_modes.MODE_CONFIGS["tiny"])

        with Image.open(preprocessed.path) as image:
            assert image.mode == "RGB"
            assert image.size == (1600, 800)

        assert preprocessed.width == 2400
        assert preprocessed.height == 1200
        assert preprocessed.preprocessed_width == 1600
        assert preprocessed.preprocessed_height == 800


def test_preprocess_document_crop_and_max_side_override() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        source = Path(tmpdir) / "phone-photo.png"
        image = Image.new("RGB", (1200, 1200), (40, 40, 40))
        paper = Image.new("RGB", (700, 900), (252, 252, 252))
        image.paste(paper, (250, 150))
        image.save(source, format="PNG")

        preprocessed = preprocess_image_for_ocr(
            source,
            Path(tmpdir),
            ocr_modes.MODE_CONFIGS["small"],
            max_side=600,
            document_crop=True,
        )

        with Image.open(preprocessed.path) as output:
            assert output.mode == "RGB"
            assert max(output.size) <= 600

        assert preprocessed.crop_applied is True
        assert preprocessed.crop_bbox is not None
        assert preprocessed.max_side == 600
        assert preprocessed.preprocessed_width < preprocessed.width
        assert preprocessed.preprocessed_height < preprocessed.height


def test_quality_heuristics() -> None:
    empty_quality = evaluate_ocr_quality([])
    assert empty_quality["fallbackReasons"] == ["no_blocks", "short_text"]

    low_confidence = evaluate_ocr_quality([{"text": "abcdefghijklmnopqrstuvwxyz", "confidence": 0.5}])
    assert "low_confidence" in low_confidence["fallbackReasons"]

    numeric_table = evaluate_ocr_quality([{"text": "12|34|56|78", "confidence": 0.95}])
    assert "short_numeric_table" in numeric_table["fallbackReasons"]


def test_image_ocr_falls_back_to_medium_once() -> None:
    calls: list[str] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            self.det_model = kwargs["text_detection_model_name"]

        def ocr(self, path: str) -> list[Any]:
            calls.append(self.det_model)
            if self.det_model == "PP-OCRv6_tiny_det":
                return [[make_line("12|34", 0.7)]]
            return [[make_line("medium fallback produced enough recognized text 1234567890", 0.96)]]

    ocr_modes.PaddleOCR = FakePaddleOCR
    clear_ocr_cache()

    result = ocr_image_bytes(make_png(), "sample.png", "image/png", mode="tiny")

    assert calls == ["PP-OCRv6_tiny_det", "PP-OCRv6_medium_det"]
    assert result["requestedOcrMode"] == "tiny"
    assert result["ocrMode"] == "medium"
    assert result["fallbackUsed"] is True
    assert result["quality"]["fallbackReasons"]
    assert result["pages"][0]["ocrMode"] == "medium"
    assert result["pages"][0]["preprocessedWidth"] <= ocr_modes.MODE_CONFIGS["medium"].preprocess_max_side
    assert result["timingsMs"]["ocr"] >= 0


def test_pdf_batch_uses_mode_dpi_and_page_range() -> None:
    rendered_dpis: list[int] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def ocr(self, path: str) -> list[Any]:
            return [[make_line("small page recognized text with enough content 1234567890", 0.96)]]

    ocr_modes.PaddleOCR = FakePaddleOCR
    clear_ocr_cache()
    ocr_pdf.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(page_count=4, rendered_dpis=rendered_dpis)

    result = ocr_pdf_batch_bytes(b"%PDF", "sample.pdf", "application/pdf", start_page=1, page_count=2, mode="small")

    assert [page["pageIndex"] for page in result["pages"]] == [1, 2]
    assert rendered_dpis == [170, 170]
    assert result["requestedOcrMode"] == "small"
    assert result["fallbackUsed"] is False
    assert result["pages"][0]["quality"]["fallbackReasons"] == []
    assert result["pages"][0]["preprocessedWidth"] <= ocr_modes.MODE_CONFIGS["small"].preprocess_max_side


def test_pdf_info_reports_text_layer_pages() -> None:
    rendered_dpis: list[int] = []
    ocr_pdf.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(
        page_count=2,
        rendered_dpis=rendered_dpis,
        text_by_page=["short", "This PDF page has enough embedded text for fast extraction."],
    )

    result = pdf_info_bytes(b"%PDF", "sample.pdf")

    assert result["pageCount"] == 2
    assert result["pages"][0] == {"pageIndex": 0, "hasTextLayer": False, "textLength": 5}
    assert result["pages"][1]["hasTextLayer"] is True
    assert rendered_dpis == []


def test_pdf_text_batch_extracts_pages_without_ocr() -> None:
    rendered_dpis: list[int] = []
    ocr_pdf.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(
        page_count=3,
        rendered_dpis=rendered_dpis,
        text_by_page=["one", "Patient Name\n白细胞 6.1 10^9/L", "three"],
    )

    result = pdf_text_batch_bytes(b"%PDF", "sample.pdf", "application/pdf", start_page=1, page_count=1)

    assert result["extractionMethod"] == "pdf_text"
    assert result["metadata"]["extractionMethod"] == "pdf_text"
    assert result["pages"][0]["pageIndex"] == 1
    assert result["pages"][0]["extractionMethod"] == "pdf_text"
    assert result["pages"][0]["text"] == "Patient Name\n白细胞 6.1 10^9/L"
    assert result["pages"][0]["blocks"][0]["confidence"] is None
    assert result["timingsMs"]["extractText"] >= 0
    assert rendered_dpis == []


def test_pdf_page_fallback_rerenders_with_medium_dpi() -> None:
    rendered_dpis: list[int] = []
    calls: list[str] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            self.det_model = kwargs["text_detection_model_name"]

        def ocr(self, path: str) -> list[Any]:
            calls.append(self.det_model)
            if self.det_model == "PP-OCRv6_tiny_det":
                return [[make_line("12|34", 0.7)]]
            return [[make_line("medium PDF fallback produced enough recognized text 1234567890", 0.96)]]

    ocr_modes.PaddleOCR = FakePaddleOCR
    clear_ocr_cache()
    ocr_pdf.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(page_count=1, rendered_dpis=rendered_dpis)

    result = ocr_pdf_batch_bytes(b"%PDF", "sample.pdf", "application/pdf", start_page=0, page_count=1, mode="tiny")

    assert calls == ["PP-OCRv6_tiny_det", "PP-OCRv6_medium_det"]
    assert rendered_dpis == [140, 220]
    assert result["fallbackUsed"] is True
    assert result["quality"]["fallbackReasons"]
    assert result["quality"]["lowQualityPageCount"] == 1
    assert result["pages"][0]["quality"]["initial"]["lowQuality"] is True
    assert result["timingsMs"]["requestedTotal"] >= 0
    assert result["timingsMs"]["fallbackTotal"] >= 0


def test_engine_info_exposes_modes() -> None:
    info = engine_info()
    assert info["modes"] == ["tiny", "small", "medium"]
    assert info["defaultMode"] == "small"
    assert info["modeConfig"]["tiny"]["pdfRenderDpi"] == 140
    assert info["modeConfig"]["small"]["preprocessMaxSide"] == 2000
    assert info["modeConfig"]["medium"]["docUnwarping"] is True
    assert info["capabilities"]["imageCompress"] is True


def main() -> None:
    test_model_source_check_env_is_configured()
    test_mode_config_and_cache()
    test_preprocess_scales_and_normalizes_rgb()
    test_preprocess_document_crop_and_max_side_override()
    test_quality_heuristics()
    test_image_ocr_falls_back_to_medium_once()
    test_pdf_batch_uses_mode_dpi_and_page_range()
    test_pdf_info_reports_text_layer_pages()
    test_pdf_text_batch_extracts_pages_without_ocr()
    test_pdf_page_fallback_rerenders_with_medium_dpi()
    test_engine_info_exposes_modes()


if __name__ == "__main__":
    main()
