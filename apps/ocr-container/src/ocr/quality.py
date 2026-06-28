from __future__ import annotations

import re
import statistics
from typing import Any


def evaluate_quality(pages: list[dict[str, Any]]) -> dict[str, Any]:
    page_blocks: list[dict[str, Any]] = []
    for page in pages:
        blocks = page.get("blocks")
        if isinstance(blocks, list):
            page_blocks.extend(block for block in blocks if isinstance(block, dict))
    quality = evaluate_ocr_quality(page_blocks)
    quality["pageCount"] = len(pages)
    quality["lowQualityPageCount"] = 1 if quality["lowQuality"] and pages else 0
    return quality


def aggregate_pdf_quality(pages: list[dict[str, Any]]) -> dict[str, Any]:
    quality = evaluate_quality(pages)
    fallback_reasons: list[str] = list(quality.get("fallbackReasons") or quality.get("reasons") or [])
    page_quality_metadata_found = False
    low_quality_page_count = 0
    for page in pages:
        page_quality = page.get("quality")
        if not isinstance(page_quality, dict):
            continue
        page_quality_metadata_found = True
        initial_quality = page_quality.get("initial")
        page_reasons = [
            *string_list(page_quality.get("fallbackReasons")),
            *string_list(page_quality.get("reasons")),
            *(string_list(initial_quality.get("fallbackReasons")) if isinstance(initial_quality, dict) else []),
            *(string_list(initial_quality.get("reasons")) if isinstance(initial_quality, dict) else []),
        ]
        append_unique(fallback_reasons, page_reasons)
        if page_quality.get("lowQuality") is True or (isinstance(initial_quality, dict) and initial_quality.get("lowQuality") is True) or page_reasons:
            low_quality_page_count += 1

    quality["fallbackReasons"] = fallback_reasons
    if page_quality_metadata_found:
        quality["lowQualityPageCount"] = low_quality_page_count
    return quality


def evaluate_ocr_quality(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    text = "\n".join(str(block.get("text", "")) for block in blocks)
    compact_text = re.sub(r"\s+", "", text)
    confidence_values = [float(block["confidence"]) for block in blocks if isinstance(block.get("confidence"), (int, float))]
    average_confidence = statistics.fmean(confidence_values) if confidence_values else None
    reasons: list[str] = []
    if not blocks:
        reasons.append("no_blocks")
    if len(compact_text) < 20:
        reasons.append("short_text")
    if average_confidence is not None and average_confidence < 0.82:
        reasons.append("low_confidence")
    digit_count = len(re.findall(r"\d", compact_text))
    tableish_count = len(re.findall(r"[%:：/\\.,，+\-|]", compact_text))
    if (digit_count >= 3 or tableish_count >= 3) and len(compact_text) < 20:
        reasons.append("short_numeric_table")
    text_score = min(1.0, len(compact_text) / 80)
    confidence_score = average_confidence if average_confidence is not None else (0.0 if not blocks else 0.75)
    score = max(0.0, min(1.0, (text_score * 0.4) + (confidence_score * 0.6)))
    numeric_ratio = digit_count / len(compact_text) if compact_text else 0.0
    return {
        "score": round(score, 4),
        "lowQuality": bool(reasons),
        "reasons": reasons,
        "fallbackReasons": reasons,
        "blockCount": len(blocks),
        "validTextLength": len(compact_text),
        "effectiveTextLength": len(compact_text),
        "avgConfidence": round(average_confidence, 4) if average_confidence is not None else None,
        "averageConfidence": round(average_confidence, 4) if average_confidence is not None else None,
        "numericRatio": round(numeric_ratio, 4),
        "tableNumericLike": digit_count >= 3 or tableish_count >= 3,
    }


def quality_with_fallback_reasons(final_quality: dict[str, Any], initial_quality: dict[str, Any]) -> dict[str, Any]:
    initial_reasons = initial_quality.get("fallbackReasons") or initial_quality.get("reasons") or []
    return {
        **final_quality,
        "fallbackReasons": list(initial_reasons) if isinstance(initial_reasons, list) else [],
        "initial": initial_quality,
    }


def string_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)
