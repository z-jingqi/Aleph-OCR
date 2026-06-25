from __future__ import annotations

import io
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.image_tools import convert_image_bytes  # noqa: E402


def make_png(mode: str = "RGBA") -> bytes:
    image = Image.new(mode, (80, 40), (255, 0, 0, 128) if mode == "RGBA" else (255, 0, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def inspect_image(content: bytes) -> Image.Image:
    return Image.open(io.BytesIO(content))


def test_png_to_webp_resize() -> None:
    data, metadata = convert_image_bytes(make_png(), "sample.png", "image/png", target_format="webp", width=20, height=20)
    image = inspect_image(data)
    assert metadata["filename"] == "sample.webp"
    assert metadata["mimeType"] == "image/webp"
    assert metadata["format"] == "webp"
    assert image.width <= 20
    assert image.height <= 20


def test_transparent_png_to_jpeg() -> None:
    data, metadata = convert_image_bytes(make_png(), "transparent.png", "image/png", target_format="jpeg", quality=80)
    image = inspect_image(data)
    assert metadata["filename"] == "transparent.jpg"
    assert metadata["mimeType"] == "image/jpeg"
    assert image.mode == "RGB"


def test_cover_resize() -> None:
    data, metadata = convert_image_bytes(make_png("RGB"), "cover.png", "image/png", target_format="png", width=20, height=20, fit="cover")
    image = inspect_image(data)
    assert metadata["width"] == 20
    assert metadata["height"] == 20
    assert image.size == (20, 20)


def test_heic_fixture_to_jpeg() -> None:
    fixture = Path(__file__).resolve().parents[2] / "gateway" / "test" / "fixtures" / "images" / "IMG_4715.HEIC"
    if not fixture.exists():
        return
    data, metadata = convert_image_bytes(fixture.read_bytes(), fixture.name, "image/heic", target_format="jpeg", quality=85, width=1200)
    image = inspect_image(data)
    assert metadata["filename"] == "IMG_4715.jpg"
    assert metadata["mimeType"] == "image/jpeg"
    assert image.width <= 1200


def main() -> None:
    test_png_to_webp_resize()
    test_transparent_png_to_jpeg()
    test_cover_resize()
    test_heic_fixture_to_jpeg()


if __name__ == "__main__":
    main()
