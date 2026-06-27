from __future__ import annotations

import argparse
import json
import mimetypes
import os
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


IMAGE_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".heif": "image/heif",
}
MODE_CHOICES = ("fast", "balanced", "accurate")
REQUIRED_MODEL_NAMES_BY_MODE = {
    "fast": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
    "balanced": ("PP-OCRv5_mobile_det", "PP-OCRv5_server_rec"),
    "accurate": ("PP-OCRv5_server_det", "PP-OCRv5_server_rec", "PP-LCNet_x1_0_doc_ori", "UVDoc", "PP-LCNet_x1_0_textline_ori"),
}


@dataclass(frozen=True)
class Fixture:
    name: str
    kind: str
    path: Path
    mime_type: str


@dataclass
class BenchmarkRecord:
    fixture: str
    kind: str
    filename: str
    mime_type: str
    mode: str
    fallback: str
    cold_ms: float | None
    warm_ms: float | None
    text_length: int | None
    avg_confidence: float | None
    pages: int | None
    status: str
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "fixture": self.fixture,
            "kind": self.kind,
            "filename": self.filename,
            "mimeType": self.mime_type,
            "mode": self.mode,
            "fallback": self.fallback,
            "coldMs": round(self.cold_ms, 2) if self.cold_ms is not None else None,
            "warmMs": round(self.warm_ms, 2) if self.warm_ms is not None else None,
            "textLength": self.text_length,
            "avgConfidence": round(self.avg_confidence, 4) if self.avg_confidence is not None else None,
            "pages": self.pages,
            "status": self.status,
            **({"error": self.error} if self.error else {}),
        }


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def fixture_root() -> Path:
    return repo_root() / "apps" / "gateway" / "test" / "fixtures"


def discover_fixtures(root: Path) -> list[Fixture]:
    image_root = root / "images"
    pdf_root = root / "pdfs"
    fixtures: list[Fixture] = []
    seen: set[Path] = set()

    preferred = [
        ("bill-receipt", "bill-image", image_root / "receipt.png"),
        ("bill-invoice-table", "bill-image", image_root / "invoice-table.png"),
        ("mobile-photo-checklist", "mobile-photo-image", image_root / "checklist-photo.png"),
        ("single-page-receipt-pdf", "single-page-pdf", pdf_root / "receipt-single-page.pdf"),
    ]
    for name, kind, path in preferred:
        if path.exists():
            fixtures.append(Fixture(name, kind, path, mime_type_for_path(path)))
            seen.add(path.resolve())

    if image_root.exists():
        for path in sorted(image_root.iterdir()):
            if path.resolve() in seen or not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in {".heic", ".heif", ".jpg", ".jpeg"}:
                fixtures.append(Fixture(f"mobile-photo-{path.stem}", "mobile-photo-image", path, mime_type_for_path(path)))
                seen.add(path.resolve())

    return fixtures


def mime_type_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "application/pdf"
    if suffix in IMAGE_MIME_BY_SUFFIX:
        return IMAGE_MIME_BY_SUFFIX[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def local_model_cache(mode: str) -> tuple[bool, str | None, list[str], list[str]]:
    roots: list[tuple[Path, bool]] = []
    for env_name in ("PADDLEOCR_HOME", "PADDLE_HOME", "PADDLE_MODEL_HOME"):
        value = os.getenv(env_name)
        if value:
            roots.append((Path(value).expanduser(), env_name == "PADDLEOCR_HOME"))
    roots.extend(
        [
            (Path("/models/paddleocr"), True),
            (Path.home() / ".paddleocr", True),
            (Path.home() / ".paddlex", False),
            (Path.home() / ".cache" / "paddleocr", True),
        ]
    )

    checked: list[str] = []
    required_models = REQUIRED_MODEL_NAMES_BY_MODE[mode]
    missing_models: list[str] = list(required_models)
    for root, trusted in dedupe_paths(roots):
        checked.append(str(root))
        missing = [model_name for model_name in required_models if not root_has_model(root, model_name, trusted)]
        if not missing:
            return True, str(root), checked, []
        missing_models = missing
    return False, None, checked, missing_models


def dedupe_paths(paths: list[tuple[Path, bool]]) -> list[tuple[Path, bool]]:
    seen: set[str] = set()
    deduped: list[tuple[Path, bool]] = []
    for path, trusted in paths:
        key = str(path)
        if key not in seen:
            seen.add(key)
            deduped.append((path, trusted))
    return deduped


def directory_has_model_files(root: Path, trusted_root: bool) -> bool:
    if not root.exists() or not root.is_dir():
        return False
    visited = 0
    for path in root.rglob("*"):
        visited += 1
        if path.is_file() and path.stat().st_size > 0:
            if trusted_root or "ocr" in "/".join(part.lower() for part in path.parts):
                return True
        if visited >= 2000:
            return trusted_root
    return False


def root_has_model(root: Path, model_name: str, trusted_root: bool) -> bool:
    if not root.exists() or not root.is_dir():
        return False
    for candidate in root.rglob(model_name):
        if candidate.is_dir() and directory_has_model_files(candidate, trusted_root):
            return True
    return False


def import_engine() -> Any:
    container_root = repo_root() / "apps" / "ocr-container"
    sys.path.insert(0, str(container_root))
    try:
        from src import ocr_engine
    except ModuleNotFoundError as error:
        raise RuntimeError(
            f"Missing Python dependency while importing OCR engine: {error}. "
            "Install apps/ocr-container/requirements.txt and prefetch models before running the benchmark."
        ) from error
    return ocr_engine


def clear_engine_cache(ocr_engine: Any) -> None:
    cache_clear = getattr(getattr(ocr_engine, "get_ocr", None), "cache_clear", None)
    if callable(cache_clear):
        cache_clear()


def run_fixture(ocr_engine: Any, fixture: Fixture, mode: str, warm_runs: int) -> BenchmarkRecord:
    fallback = "auto-accurate-enabled" if mode in {"fast", "balanced"} else "disabled-for-accurate"
    try:
        clear_engine_cache(ocr_engine)
        cold_ms, cold_result = timed(lambda: run_ocr(ocr_engine, fixture, mode))
        warm_measurements: list[float] = []
        warm_result = cold_result
        for _ in range(warm_runs):
            elapsed_ms, warm_result = timed(lambda: run_ocr(ocr_engine, fixture, mode))
            warm_measurements.append(elapsed_ms)
        summary = summarize_result(warm_result)
        fallback = "used" if warm_result.get("fallbackUsed") else "not-used"
        return BenchmarkRecord(
            fixture=fixture.name,
            kind=fixture.kind,
            filename=str(fixture.path.relative_to(repo_root())),
            mime_type=fixture.mime_type,
            mode=mode,
            fallback=fallback,
            cold_ms=cold_ms,
            warm_ms=statistics.fmean(warm_measurements) if warm_measurements else None,
            text_length=summary["textLength"],
            avg_confidence=summary["avgConfidence"],
            pages=summary["pages"],
            status="ok",
        )
    except Exception as error:
        return BenchmarkRecord(
            fixture=fixture.name,
            kind=fixture.kind,
            filename=str(fixture.path.relative_to(repo_root())),
            mime_type=fixture.mime_type,
            mode=mode,
            fallback=f"error:{error.__class__.__name__}",
            cold_ms=None,
            warm_ms=None,
            text_length=None,
            avg_confidence=None,
            pages=None,
            status="failed",
            error=str(error),
        )


def run_ocr(ocr_engine: Any, fixture: Fixture, mode: str) -> dict[str, Any]:
    content = fixture.path.read_bytes()
    if fixture.mime_type == "application/pdf":
        return ocr_engine.ocr_pdf_bytes(content, fixture.path.name, fixture.mime_type, mode=mode)
    return ocr_engine.ocr_image_bytes(content, fixture.path.name, fixture.mime_type, mode=mode)


def timed(callback: Callable[[], dict[str, Any]]) -> tuple[float, dict[str, Any]]:
    started = time.perf_counter()
    result = callback()
    return (time.perf_counter() - started) * 1000, result


def summarize_result(result: dict[str, Any]) -> dict[str, Any]:
    pages = result.get("pages")
    page_list = pages if isinstance(pages, list) else []
    text = result.get("plainText")
    if not isinstance(text, str):
        text = "\n\n".join(str(page.get("text", "")) for page in page_list if isinstance(page, dict))

    confidence_values: list[float] = []
    for page in page_list:
        if not isinstance(page, dict):
            continue
        confidence = page.get("confidence")
        if isinstance(confidence, (int, float)):
            confidence_values.append(float(confidence))
            continue
        blocks = page.get("blocks")
        if isinstance(blocks, list):
            for block in blocks:
                if isinstance(block, dict) and isinstance(block.get("confidence"), (int, float)):
                    confidence_values.append(float(block["confidence"]))

    return {
        "textLength": len(text),
        "avgConfidence": statistics.fmean(confidence_values) if confidence_values else None,
        "pages": len(page_list),
    }


def skipped_records(fixtures: list[Fixture], mode: str, fallback: str, message: str) -> list[BenchmarkRecord]:
    return [
        BenchmarkRecord(
            fixture=fixture.name,
            kind=fixture.kind,
            filename=str(fixture.path.relative_to(repo_root())),
            mime_type=fixture.mime_type,
            mode=mode,
            fallback=fallback,
            cold_ms=None,
            warm_ms=None,
            text_length=None,
            avg_confidence=None,
            pages=None,
            status="skipped",
            error=message,
        )
        for fixture in fixtures
    ]


def render_table(records: list[BenchmarkRecord]) -> str:
    headers = ["fixture", "kind", "mode", "fallback", "cold_ms", "warm_ms", "text_len", "avg_conf", "pages", "status"]
    rows = [
        [
            record.fixture,
            record.kind,
            record.mode,
            record.fallback,
            format_ms(record.cold_ms),
            format_ms(record.warm_ms),
            "-" if record.text_length is None else str(record.text_length),
            "-" if record.avg_confidence is None else f"{record.avg_confidence:.4f}",
            "-" if record.pages is None else str(record.pages),
            record.status,
        ]
        for record in records
    ]
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    lines = ["  ".join(header.ljust(widths[index]) for index, header in enumerate(headers))]
    lines.append("  ".join("-" * width for width in widths))
    lines.extend("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)) for row in rows)
    return "\n".join(lines)


def format_ms(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}"


def write_output(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local OCR benchmark against repository fixtures by calling the Python OCR engine directly.",
    )
    parser.add_argument("--mode", choices=MODE_CHOICES, default="balanced", help="OCR mode label to record. Default: balanced.")
    parser.add_argument("--format", choices=("table", "json", "ndjson"), default="table", help="Output format. Default: table.")
    parser.add_argument("--output", type=Path, help="Optional JSON file path for the complete benchmark payload.")
    parser.add_argument("--warm-runs", type=int, default=1, help="Warm repetitions per fixture after the cold run. Default: 1.")
    parser.add_argument("--fixture-root", type=Path, default=fixture_root(), help="Fixture root. Default: apps/gateway/test/fixtures.")
    parser.add_argument("--list-fixtures", action="store_true", help="List discovered fixtures without importing PaddleOCR.")
    parser.add_argument(
        "--no-model-cache-check",
        action="store_true",
        help="Bypass the local model cache check. Use only when models are preloaded in a non-standard location.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    raw_args = list(argv or sys.argv[1:])
    if raw_args and raw_args[0] == "--":
        raw_args = raw_args[1:]
    args = parse_args(raw_args)
    if args.warm_runs < 1:
        raise SystemExit("--warm-runs must be at least 1")

    fixtures = discover_fixtures(args.fixture_root)
    if args.list_fixtures:
        for fixture in fixtures:
            print(f"{fixture.name}\t{fixture.kind}\t{fixture.mime_type}\t{fixture.path}")
        return 0
    if not fixtures:
        print(f"No benchmark fixtures found under {args.fixture_root}", file=sys.stderr)
        return 1

    model_present, model_path, checked_paths, missing_models = local_model_cache(args.mode)
    if not args.no_model_cache_check and not model_present:
        message = (
            f"Required PaddleOCR models for {args.mode} mode are missing ({', '.join(missing_models)}). "
            "Run apps/ocr-container/scripts/download-models.sh "
            "in a prepared network-enabled environment, or rerun with --no-model-cache-check if models are mounted elsewhere."
        )
        records = skipped_records(fixtures, args.mode, "model-cache-incomplete", message)
        payload = benchmark_payload(args, records, model_present, model_path, checked_paths, missing_models)
        emit(args, payload, records)
        print(message, file=sys.stderr)
        return 2

    try:
        ocr_engine = import_engine()
    except RuntimeError as error:
        records = skipped_records(fixtures, args.mode, "dependency-missing", str(error))
        payload = benchmark_payload(args, records, model_present, model_path, checked_paths, missing_models)
        emit(args, payload, records)
        print(str(error), file=sys.stderr)
        return 2

    records = [run_fixture(ocr_engine, fixture, args.mode, args.warm_runs) for fixture in fixtures]
    payload = benchmark_payload(args, records, model_present, model_path, checked_paths, missing_models)
    emit(args, payload, records)
    return 1 if any(record.status == "failed" for record in records) else 0


def benchmark_payload(
    args: argparse.Namespace,
    records: list[BenchmarkRecord],
    model_present: bool,
    model_path: str | None,
    checked_paths: list[str],
    missing_models: list[str],
) -> dict[str, Any]:
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "warmRuns": args.warm_runs,
        "fixtureRoot": str(args.fixture_root),
        "directEngine": True,
        "serviceStarted": False,
        "modelCache": {"present": model_present, "path": model_path, "checkedPaths": checked_paths, "missingModels": missing_models},
        "results": [record.to_json() for record in records],
    }


def emit(args: argparse.Namespace, payload: dict[str, Any], records: list[BenchmarkRecord]) -> None:
    if args.format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif args.format == "ndjson":
        for record in records:
            print(json.dumps(record.to_json(), ensure_ascii=False))
    else:
        print(render_table(records))

    if args.output:
        write_output(args.output, payload)


if __name__ == "__main__":
    raise SystemExit(main())
