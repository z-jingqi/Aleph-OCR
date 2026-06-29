# OCR Performance Benchmarking

This document defines the local benchmark workflow and the acceptance checks for OCR performance changes. It is intentionally service-free: the benchmark calls the Python engine functions directly and never starts the FastAPI container, Worker gateway, D1, R2, Queues, or Workflows.

## Local Benchmark

Use the container package script:

```bash
pnpm --filter @aleph-tools/tools-container benchmark:ocr
```

Or call the script directly:

```bash
cd apps/ocr-container
python3 scripts/benchmark-ocr.py --mode small --format table
```

Useful variants:

```bash
python3 scripts/benchmark-ocr.py --list-fixtures
python3 scripts/benchmark-ocr.py --mode small --format json --output /tmp/aleph-tools-ocr-benchmark.json
python3 scripts/benchmark-ocr.py --mode small --format ndjson
```

The script discovers existing repository fixtures under `apps/gateway/test/fixtures`:

- Bill images: `images/receipt.png` and `images/invoice-table.png`.
- Mobile-photo-style images: `images/checklist-photo.png`, plus any local `.jpg`, `.jpeg`, `.heic`, or `.heif` files if present.
- Single-page PDF: `pdfs/receipt-single-page.pdf`.

The script reports one row per fixture:

- `cold_ms`: first direct engine call after clearing the cached PaddleOCR object for that fixture.
- `warm_ms`: immediate repeat call using the cached PaddleOCR object.
- `mode`: requested benchmark mode label.
- `fallback`: `used`, `not-used`, or the reason a fixture was skipped/failed.
- `text_len`: OCR plain-text length.
- `avg_conf`: mean page confidence, falling back to block confidence values when needed.
- `pages`: page count returned by the engine.

If required PaddleOCR models for the requested mode are missing, the script emits skipped rows with `fallback=model-cache-incomplete` and exits without running inference. This keeps local validation from implicitly downloading models. Use `--no-model-cache-check` only when models are mounted or cached in a non-standard path.

Generated benchmark JSON files are local evidence and should not be committed. Keep them under `/tmp`, CI artifacts, or release evidence storage.

## OCR Modes

Public clients should treat `small` as the default OCR mode. Mode semantics are:

| Mode | Intent | Expected tradeoff |
| --- | --- | --- |
| `tiny` | Preview or low-latency OCR on simple images. | Lowest latency, lower tolerance for skewed or dense documents. |
| `small` | Default production path. | Balanced PP-OCRv6 quality and latency budget. |
| `medium` | Quality-first processing for difficult documents. | Higher latency and resource usage. |

The Python engine runs the requested mode directly. `tiny` and `small` automatically retry once with `medium` when quality heuristics mark the first pass as low quality. `medium` does not fallback.

## Fallback Semantics

There are two fallback layers to keep separate:

- Quality fallback: `tiny` and `small` run a second `medium` pass when the first pass returns no blocks, very short text, low average confidence, or an abnormally short numeric/table-like result. Results expose `fallbackUsed=true`, `requestedOcrMode`, final `ocrMode`, `quality.fallbackReasons`, and `timingsMs.requestedTotal/fallbackTotal`.
- Execution fallback: the gateway starts Cloudflare Workflows when configured and falls back to the queue processor when only `TOOLS_JOBS` is available. The local benchmark bypasses both paths and does not validate Workflow or Queue latency.

Fallback is a quality signal, not a failure. Production acceptance should fail when fallback is caused by missing models or dependencies, but quality fallback is expected for difficult inputs as long as `fallbackUsed` and timings are recorded.

## Cold And Warm Measurements

Cold and warm values answer different questions:

- Cold time includes constructing the cached PaddleOCR object plus inference for the fixture. It does not include starting FastAPI, Worker startup, container scheduling, or network transfer.
- Warm time measures repeat inference with the cached OCR object in the same Python process.

Use warm time for steady-state regression checks. Use cold time to validate that model files are already local and that first-use initialization remains within the container startup budget.

## Cloudflare Container Model Predownload

Cloudflare Containers should not discover or download OCR models during a live request. The container image or deployment pipeline should prepare the model cache before serving traffic:

```bash
cd apps/ocr-container
PADDLEOCR_HOME=/models/paddleocr scripts/download-models.sh
```

The current container environment sets `PADDLEOCR_HOME=/models/paddleocr`. A production image should preserve that directory with the downloaded PaddleOCR assets. If the runtime container starts without those files, the first request may attempt model resolution, which is both slow and unsuitable for restricted egress deployments.

Build and benchmark OCR images as `linux/amd64`:

```bash
docker build --platform linux/amd64 -t aleph-tools-container:amd64-test apps/ocr-container
```

Local Apple Silicon arm64 containers are useful for image conversion/compression checks, but they are not accepted for OCR inference sign-off. PaddleOCR 3.7.0 and PaddlePaddle 3.2.2 can crash in the arm64 OCR predictor path even when model initialization succeeds. Use amd64 local images and Cloudflare preview smoke tests for OCR acceptance.

Validation checks before promoting an image:

- The image contains a non-empty `/models/paddleocr` cache or an equivalent configured model directory.
- A container-local benchmark reports `modelCache.present=true`.
- Cold benchmark logs do not show model downloads or remote model resolution.
- Default `small` fixtures report either `fallback=not-used` or `fallback=used` with explicit `quality.fallbackReasons`.

## Performance Acceptance Criteria

Use the existing fixtures for local regression checks. Do not run large-model or large-document benchmarks as part of normal local validation.

Minimum correctness gates:

- Every discovered default fixture completes in `small` mode.
- Any quality fallback records `fallbackUsed=true`, final `ocrMode=medium`, and non-zero fallback timings.
- `text_len > 0` for every fixture.
- `avg_conf` is present for every fixture that returns OCR blocks.

Initial latency gates for the current CPU container class:

- Warm bill or mobile-photo image fixture: target < 8 seconds.
- Warm single-page PDF fixture: target < 10 seconds.
- Cold single fixture: target <= 45 seconds when models are predownloaded.

Regression gates once a baseline JSON is captured on the target machine:

- Compare only against a baseline from the same machine class, container image, PaddleOCR version, and fixture set.
- A change fails review if median warm time regresses by more than 20% without a documented reason.
- A change fails review if confidence drops by more than 0.05 absolute on any default fixture without a documented reason.

Manual benchmark evidence should include the command, git commit, machine/container class, model cache path, and the JSON output file path.
