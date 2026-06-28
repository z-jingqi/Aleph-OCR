from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

try:
    import pillow_avif  # noqa: F401
except Exception:
    pillow_avif = None

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    pillow_heif = True
except Exception:
    pillow_heif = False

SUPPORTED_INPUT_TYPES = {"image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp", "image/heic", "image/heif"}
FORMAT_TO_MIME = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "avif": "image/avif",
}
COMPRESS_FORMAT_TO_MIME = {
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}
PIL_FORMAT = {
    "png": "PNG",
    "jpeg": "JPEG",
    "webp": "WEBP",
    "avif": "AVIF",
}


def convert_image_bytes(
    content: bytes,
    filename: str,
    mime_type: str,
    target_format: str,
    quality: int | None = None,
    width: int | None = None,
    height: int | None = None,
    fit: str = "inside",
) -> tuple[bytes, dict[str, Any]]:
    target_format = target_format.lower()
    if mime_type not in SUPPORTED_INPUT_TYPES:
        raise ValueError(f"Unsupported image type: {mime_type}")
    if mime_type in {"image/heic", "image/heif"} and not pillow_heif:
        raise ValueError("HEIC/HEIF input is not supported by this container image")
    if target_format not in FORMAT_TO_MIME:
        raise ValueError(f"Unsupported target format: {target_format}")
    if target_format == "avif" and pillow_avif is None:
        raise ValueError("AVIF output is not supported by this container image")
    if fit not in {"contain", "cover", "inside"}:
        raise ValueError(f"Unsupported fit mode: {fit}")
    if quality is not None and (quality < 1 or quality > 100):
        raise ValueError("quality must be between 1 and 100")

    with Image.open(io.BytesIO(content)) as source:
        image = ImageOps.exif_transpose(source)
        image = resize_image(image, width, height, fit)
        image = normalize_mode(image, target_format)
        output = io.BytesIO()
        save_options: dict[str, Any] = {}
        if target_format in {"jpeg", "webp", "avif"} and quality is not None:
            save_options["quality"] = quality
        if target_format == "jpeg":
            save_options["optimize"] = True
        image.save(output, format=PIL_FORMAT[target_format], **save_options)
        data = output.getvalue()
        output_width = image.width
        output_height = image.height

    output_filename = converted_filename(filename, target_format)
    return data, {
        "filename": output_filename,
        "mimeType": FORMAT_TO_MIME[target_format],
        "sizeBytes": len(data),
        "width": output_width,
        "height": output_height,
        "format": target_format,
    }


def compress_image_bytes(
    content: bytes,
    filename: str,
    mime_type: str,
    target_size_bytes: int | None = None,
    max_width: int | None = None,
    max_height: int | None = None,
    min_quality: int = 45,
    max_quality: int = 85,
    output_format: str = "jpeg",
) -> tuple[bytes, dict[str, Any]]:
    output_format = output_format.lower()
    if mime_type not in SUPPORTED_INPUT_TYPES:
        raise ValueError(f"Unsupported image type: {mime_type}")
    if mime_type in {"image/heic", "image/heif"} and not pillow_heif:
        raise ValueError("HEIC/HEIF input is not supported by this container image")
    if output_format not in COMPRESS_FORMAT_TO_MIME:
        raise ValueError(f"Unsupported compression format: {output_format}")
    if target_size_bytes is not None and target_size_bytes <= 0:
        raise ValueError("targetSizeBytes must be positive")
    if max_width is not None and max_width <= 0:
        raise ValueError("maxWidth must be positive")
    if max_height is not None and max_height <= 0:
        raise ValueError("maxHeight must be positive")
    if min_quality < 1 or min_quality > 100 or max_quality < 1 or max_quality > 100:
        raise ValueError("quality must be between 1 and 100")
    if min_quality > max_quality:
        raise ValueError("minQuality must be less than or equal to maxQuality")

    with Image.open(io.BytesIO(content)) as source:
        image = ImageOps.exif_transpose(source)
        image = resize_for_compression(image, max_width, max_height)
        image = normalize_mode(image, output_format)
        data, quality = encode_compressed(image, output_format, min_quality, max_quality, target_size_bytes)
        width = image.width
        height = image.height

    size_bytes = len(data)
    target_met = target_size_bytes is None or size_bytes <= target_size_bytes
    return data, {
        "filename": compressed_filename(filename, output_format),
        "mimeType": COMPRESS_FORMAT_TO_MIME[output_format],
        "originalSizeBytes": len(content),
        "sizeBytes": size_bytes,
        "compressionRatio": size_bytes / len(content) if content else 0,
        **({"targetSizeBytes": target_size_bytes} if target_size_bytes is not None else {}),
        "targetMet": target_met,
        "width": width,
        "height": height,
        "format": output_format,
        "quality": quality,
    }


def resize_for_compression(image: Image.Image, max_width: int | None, max_height: int | None) -> Image.Image:
    if max_width is None and max_height is None:
        return image.copy()
    target_width = max_width or image.width
    target_height = max_height or image.height
    resized = image.copy()
    resized.thumbnail((target_width, target_height), Image.Resampling.LANCZOS)
    return resized


def encode_compressed(image: Image.Image, output_format: str, min_quality: int, max_quality: int, target_size_bytes: int | None) -> tuple[bytes, int]:
    if target_size_bytes is None:
        return save_image(image, output_format, max_quality), max_quality

    best_under: tuple[bytes, int] | None = None
    smallest: tuple[bytes, int] | None = None
    low = min_quality
    high = max_quality
    while low <= high:
        quality = (low + high) // 2
        data = save_image(image, output_format, quality)
        if smallest is None or len(data) < len(smallest[0]):
            smallest = (data, quality)
        if len(data) <= target_size_bytes:
            best_under = (data, quality)
            low = quality + 1
        else:
            high = quality - 1
    return best_under or smallest or (save_image(image, output_format, min_quality), min_quality)


def save_image(image: Image.Image, output_format: str, quality: int) -> bytes:
    output = io.BytesIO()
    options: dict[str, Any] = {"quality": quality, "optimize": True}
    if output_format == "webp":
        options["method"] = 6
    image.save(output, format=PIL_FORMAT[output_format], **options)
    return output.getvalue()


def resize_image(image: Image.Image, width: int | None, height: int | None, fit: str) -> Image.Image:
    if width is None and height is None:
        return image.copy()
    if width is not None and width <= 0:
        raise ValueError("width must be positive")
    if height is not None and height <= 0:
        raise ValueError("height must be positive")

    target_width = width or image.width
    target_height = height or image.height
    if fit == "cover":
        return ImageOps.fit(image, (target_width, target_height), method=Image.Resampling.LANCZOS)
    resized = image.copy()
    resized.thumbnail((target_width, target_height), Image.Resampling.LANCZOS)
    return resized


def normalize_mode(image: Image.Image, target_format: str) -> Image.Image:
    if target_format == "jpeg":
        if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
            return background
        return image.convert("RGB")
    if target_format in {"webp", "avif", "png"}:
        return image.convert("RGBA") if image.mode not in {"RGB", "RGBA"} else image.copy()
    return image.copy()


def converted_filename(filename: str, target_format: str) -> str:
    suffix = ".jpg" if target_format == "jpeg" else f".{target_format}"
    path = Path(filename or "image")
    stem = path.stem or "image"
    return f"{stem}{suffix}"


def compressed_filename(filename: str, target_format: str) -> str:
    suffix = ".jpg" if target_format == "jpeg" else f".{target_format}"
    path = Path(filename or "image")
    stem = path.stem or "image"
    return f"{stem}.compressed{suffix}"
