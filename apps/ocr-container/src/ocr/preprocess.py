from __future__ import annotations

import time
from dataclasses import dataclass
from math import floor, ceil
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
    crop_applied: bool = False
    crop_bbox: tuple[int, int, int, int] | None = None
    max_side: int | None = None


def preprocess_image_path(
    image_path: Path,
    tmpdir: Path,
    mode: OcrMode,
    page_index: int,
    max_side: int | None = None,
    document_crop: bool = False,
) -> PreprocessedImage:
    config = OCR_MODE_CONFIGS[mode]
    return preprocess_image_for_ocr(image_path, tmpdir, config, suffix=f"{page_index + 1}-{mode}", max_side=max_side, document_crop=document_crop)


def preprocess_image_for_ocr(
    image_path: Path,
    tmpdir: Path,
    config: OcrModeConfig,
    suffix: str = "image",
    max_side: int | None = None,
    document_crop: bool = False,
) -> PreprocessedImage:
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
        crop_bbox = None
        if document_crop:
            image, crop_bbox = crop_document_region(image)
        effective_max_side = min(max_side, config.max_side) if max_side else config.max_side
        image = resize_to_max_side(image, effective_max_side)
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
        crop_applied=crop_bbox is not None,
        crop_bbox=crop_bbox,
        max_side=effective_max_side,
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


def crop_document_region(image: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int] | None]:
    if image.width < 300 or image.height < 300:
        return image, None
    bright_bbox = candidate_bbox(image, threshold=180, bright=True, margin_ratio=0.03)
    if bright_bbox and is_useful_crop(image.size, bright_bbox):
        return image.crop(bright_bbox), bright_bbox
    content_bbox = candidate_bbox(image, threshold=245, bright=False, margin_ratio=0.08)
    if content_bbox and is_useful_crop(image.size, content_bbox):
        return image.crop(content_bbox), content_bbox
    return image, None


def candidate_bbox(image: Image.Image, threshold: int, bright: bool, margin_ratio: float) -> tuple[int, int, int, int] | None:
    sample = ImageOps.grayscale(image)
    sample.thumbnail((900, 900), Image.Resampling.BILINEAR)
    mask = sample.point(lambda pixel: 255 if (pixel >= threshold if bright else pixel <= threshold) else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return None
    x_scale = image.width / sample.width
    y_scale = image.height / sample.height
    left = floor(bbox[0] * x_scale)
    upper = floor(bbox[1] * y_scale)
    right = ceil(bbox[2] * x_scale)
    lower = ceil(bbox[3] * y_scale)
    margin_x = max(12, round((right - left) * margin_ratio), round(image.width * 0.01))
    margin_y = max(12, round((lower - upper) * margin_ratio), round(image.height * 0.01))
    return (
        max(0, left - margin_x),
        max(0, upper - margin_y),
        min(image.width, right + margin_x),
        min(image.height, lower + margin_y),
    )


def is_useful_crop(size: tuple[int, int], bbox: tuple[int, int, int, int]) -> bool:
    width, height = size
    crop_width = bbox[2] - bbox[0]
    crop_height = bbox[3] - bbox[1]
    if crop_width <= 0 or crop_height <= 0:
        return False
    if crop_width < width * 0.2 or crop_height < height * 0.2:
        return False
    original_area = width * height
    crop_area = crop_width * crop_height
    return crop_area <= original_area * 0.92
