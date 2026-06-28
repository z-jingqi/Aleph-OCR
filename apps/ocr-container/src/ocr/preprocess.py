from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

from .modes import OCR_MODE_CONFIGS, OcrMode, OcrModeConfig
from .timings import elapsed_ms


@dataclass(frozen=True)
class PreprocessedImage:
    path: Path
    width: int
    height: int
    preprocessed_width: int
    preprocessed_height: int
    decode_ms: float
    preprocess_ms: float


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
