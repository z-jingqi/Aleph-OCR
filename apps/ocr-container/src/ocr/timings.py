from __future__ import annotations

import time
from typing import Any


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def empty_timings() -> dict[str, float]:
    return {"decode": 0.0, "preprocess": 0.0, "modelInit": 0.0, "ocr": 0.0, "normalize": 0.0, "total": 0.0}


def add_timings(left: dict[str, Any], right: dict[str, Any]) -> dict[str, float]:
    merged = empty_timings()
    for key in set(merged) | set(left) | set(right):
        left_value = left.get(key, 0)
        right_value = right.get(key, 0)
        if isinstance(left_value, (int, float)) and isinstance(right_value, (int, float)):
            merged[key] = float(left_value) + float(right_value)
    return merged


def add_timings_in_place(target: dict[str, float], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, (int, float)):
            target[key] = target.get(key, 0.0) + float(value)


def finish_aggregate_timings(timings: dict[str, float], requested_total: float, fallback_total: float) -> dict[str, float]:
    total = timings.get("decode", 0.0) + timings.get("preprocess", 0.0) + timings.get("modelInit", 0.0) + timings.get("ocr", 0.0) + timings.get("normalize", 0.0)
    timings["total"] = total
    timings["requestedTotal"] = requested_total
    timings["fallbackTotal"] = fallback_total
    return timings
