from __future__ import annotations

from typing import Any


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
