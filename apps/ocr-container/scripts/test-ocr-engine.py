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

from src import ocr_engine  # noqa: E402


def make_line(text: str, confidence: float) -> list[Any]:
    return [[[0, 0], [120, 0], [120, 24], [0, 24]], [text, confidence]]


def make_png(width: int = 1200, height: int = 800, mode: str = "RGBA") -> bytes:
    color = (255, 255, 255, 255) if mode == "RGBA" else (255, 255, 255)
    image = Image.new(mode, (width, height), color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakePdfPage:
    def __init__(self, page_index: int, rendered_dpis: list[int]) -> None:
        self.page_index = page_index
        self.rendered_dpis = rendered_dpis

    def get_pixmap(self, dpi: int, alpha: bool) -> "FakePixmap":
        assert alpha is False
        self.rendered_dpis.append(dpi)
        return FakePixmap()


class FakePixmap:
    def save(self, path: Path) -> None:
        path.write_bytes(make_png(width=800, height=600, mode="RGB"))


class FakePdfDoc:
    def __init__(self, page_count: int, rendered_dpis: list[int]) -> None:
        self.page_count = page_count
        self.rendered_dpis = rendered_dpis

    def load_page(self, page_index: int) -> FakePdfPage:
        return FakePdfPage(page_index, self.rendered_dpis)

    def close(self) -> None:
        pass


def test_model_source_check_env_is_configured() -> None:
    app_dir = Path(__file__).resolve().parents[1]
    dockerfile = (app_dir / "Dockerfile").read_text()
    download_script = (app_dir / "scripts" / "download-models.sh").read_text()

    assert "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True" in dockerfile
    assert "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK" in download_script
    assert "DISABLE_MODEL_SOURCE_CHECK" in dockerfile
    assert "DISABLE_MODEL_SOURCE_CHECK" in download_script


def test_mode_config_and_cache() -> None:
    created: list[dict[str, Any]] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            created.append(kwargs)

        def ocr(self, path: str) -> list[Any]:
            return []

    ocr_engine.PaddleOCR = FakePaddleOCR
    ocr_engine.clear_ocr_cache()

    fast_a = ocr_engine.get_ocr("FAST")
    fast_b = ocr_engine.get_ocr("fast")
    balanced = ocr_engine.get_ocr("balanced")
    accurate = ocr_engine.get_ocr("accurate")

    assert fast_a is fast_b
    assert balanced is not fast_a
    assert accurate is not balanced
    assert created[0]["text_detection_model_name"] == "PP-OCRv5_mobile_det"
    assert created[0]["text_recognition_model_name"] == "PP-OCRv5_mobile_rec"
    assert created[0]["use_doc_orientation_classify"] is False
    assert created[1]["text_detection_model_name"] == "PP-OCRv5_mobile_det"
    assert created[1]["text_recognition_model_name"] == "PP-OCRv5_server_rec"
    assert created[2]["text_detection_model_name"] == "PP-OCRv5_server_det"
    assert created[2]["text_recognition_model_name"] == "PP-OCRv5_server_rec"
    assert created[2]["use_doc_orientation_classify"] is True
    assert created[2]["use_doc_unwarping"] is True
    assert created[2]["use_textline_orientation"] is True


def test_preprocess_scales_and_normalizes_rgb() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        source = Path(tmpdir) / "large.png"
        source.write_bytes(make_png(width=2400, height=1200, mode="RGBA"))
        preprocessed = ocr_engine.preprocess_image_for_ocr(source, Path(tmpdir), ocr_engine.MODE_CONFIGS["fast"])

        with Image.open(preprocessed.path) as image:
            assert image.mode == "RGB"
            assert image.size == (1800, 900)

        assert preprocessed.width == 2400
        assert preprocessed.height == 1200
        assert preprocessed.preprocessed_width == 1800
        assert preprocessed.preprocessed_height == 900


def test_quality_heuristics() -> None:
    empty_quality = ocr_engine.evaluate_ocr_quality([])
    assert empty_quality["fallbackReasons"] == ["no_blocks", "short_text"]

    low_confidence = ocr_engine.evaluate_ocr_quality([{"text": "abcdefghijklmnopqrstuvwxyz", "confidence": 0.5}])
    assert "low_confidence" in low_confidence["fallbackReasons"]

    numeric_table = ocr_engine.evaluate_ocr_quality([{"text": "12|34|56|78", "confidence": 0.95}])
    assert "short_numeric_table" in numeric_table["fallbackReasons"]


def test_image_ocr_falls_back_to_accurate_once() -> None:
    calls: list[str] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            self.det_model = kwargs["text_detection_model_name"]

        def ocr(self, path: str) -> list[Any]:
            calls.append(self.det_model)
            if self.det_model == "PP-OCRv5_mobile_det":
                return [[make_line("12|34", 0.7)]]
            return [[make_line("accurate fallback produced enough recognized text 1234567890", 0.96)]]

    ocr_engine.PaddleOCR = FakePaddleOCR
    ocr_engine.clear_ocr_cache()

    result = ocr_engine.ocr_image_bytes(make_png(), "sample.png", "image/png", mode="fast")

    assert calls == ["PP-OCRv5_mobile_det", "PP-OCRv5_server_det"]
    assert result["requestedOcrMode"] == "fast"
    assert result["ocrMode"] == "accurate"
    assert result["fallbackUsed"] is True
    assert result["quality"]["fallbackReasons"]
    assert result["pages"][0]["ocrMode"] == "accurate"
    assert result["pages"][0]["preprocessedWidth"] <= ocr_engine.MODE_CONFIGS["accurate"].preprocess_max_side
    assert result["timingsMs"]["ocr"] >= 0


def test_pdf_batch_uses_mode_dpi_and_page_range() -> None:
    rendered_dpis: list[int] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def ocr(self, path: str) -> list[Any]:
            return [[make_line("balanced page recognized text with enough content 1234567890", 0.96)]]

    ocr_engine.PaddleOCR = FakePaddleOCR
    ocr_engine.clear_ocr_cache()
    ocr_engine.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(page_count=4, rendered_dpis=rendered_dpis)

    result = ocr_engine.ocr_pdf_batch_bytes(b"%PDF", "sample.pdf", "application/pdf", start_page=1, page_count=2, mode="balanced")

    assert [page["pageIndex"] for page in result["pages"]] == [1, 2]
    assert rendered_dpis == [180, 180]
    assert result["requestedOcrMode"] == "balanced"
    assert result["fallbackUsed"] is False
    assert result["pages"][0]["quality"]["fallbackReasons"] == []
    assert result["pages"][0]["preprocessedWidth"] <= ocr_engine.MODE_CONFIGS["balanced"].preprocess_max_side


def test_pdf_page_fallback_rerenders_with_accurate_dpi() -> None:
    rendered_dpis: list[int] = []
    calls: list[str] = []

    class FakePaddleOCR:
        def __init__(self, **kwargs: Any) -> None:
            self.det_model = kwargs["text_detection_model_name"]

        def ocr(self, path: str) -> list[Any]:
            calls.append(self.det_model)
            if self.det_model == "PP-OCRv5_mobile_det":
                return [[make_line("12|34", 0.7)]]
            return [[make_line("accurate PDF fallback produced enough recognized text 1234567890", 0.96)]]

    ocr_engine.PaddleOCR = FakePaddleOCR
    ocr_engine.clear_ocr_cache()
    ocr_engine.fitz.open = lambda *_args, **_kwargs: FakePdfDoc(page_count=1, rendered_dpis=rendered_dpis)

    result = ocr_engine.ocr_pdf_batch_bytes(b"%PDF", "sample.pdf", "application/pdf", start_page=0, page_count=1, mode="fast")

    assert calls == ["PP-OCRv5_mobile_det", "PP-OCRv5_server_det"]
    assert rendered_dpis == [150, 220]
    assert result["fallbackUsed"] is True
    assert result["quality"]["fallbackReasons"]
    assert result["quality"]["lowQualityPageCount"] == 1
    assert result["pages"][0]["quality"]["initial"]["lowQuality"] is True
    assert result["timingsMs"]["requestedTotal"] >= 0
    assert result["timingsMs"]["fallbackTotal"] >= 0


def test_engine_info_exposes_modes() -> None:
    info = ocr_engine.engine_info()
    assert info["ocrModes"] == ["fast", "balanced", "accurate"]
    assert info["defaultOcrMode"] == "balanced"
    assert info["modeConfigs"]["fast"]["pdfRenderDpi"] == 150
    assert info["modeConfigs"]["balanced"]["preprocessMaxSide"] == 2200
    assert info["modeConfigs"]["accurate"]["docUnwarping"] is True


def main() -> None:
    test_model_source_check_env_is_configured()
    test_mode_config_and_cache()
    test_preprocess_scales_and_normalizes_rgb()
    test_quality_heuristics()
    test_image_ocr_falls_back_to_accurate_once()
    test_pdf_batch_uses_mode_dpi_and_page_range()
    test_pdf_page_fallback_rerenders_with_accurate_dpi()
    test_engine_info_exposes_modes()


if __name__ == "__main__":
    main()
