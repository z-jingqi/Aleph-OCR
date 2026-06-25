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
