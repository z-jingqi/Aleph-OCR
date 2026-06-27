from __future__ import annotations

import os

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .image_tools import SUPPORTED_INPUT_TYPES, convert_image_bytes
from .ocr_engine import DEFAULT_OCR_MODE, engine_info, get_ocr, ocr_image_bytes, ocr_pdf_batch_bytes, ocr_pdf_bytes, ocr_pdf_page_bytes, pdf_info_bytes

app = FastAPI(title="Aleph Tools Engine", version="0.1.0")

SUPPORTED_IMAGE_TYPES = SUPPORTED_INPUT_TYPES
MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024


@app.on_event("startup")
def warm_default_ocr_mode() -> None:
    if os.getenv("PRELOAD_OCR", "true").lower() not in {"0", "false", "no"}:
        get_ocr(DEFAULT_OCR_MODE)


@app.get("/health")
def health():
    return engine_info()


@app.post("/internal/ocr/image")
async def ocr_image(
    file: UploadFile = File(...),
    mode: str = Query(default=DEFAULT_OCR_MODE),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    if file.content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {file.content_type}")
    content = await file.read()
    if len(content) > MAX_SYNC_IMAGE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds sync OCR size limit")
    try:
        return JSONResponse(ocr_image_bytes(content, file.filename or "image", file.content_type or "image/png", mode))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/internal/image/convert")
async def image_convert(
    file: UploadFile = File(...),
    target_format: str = Form(...),
    quality: int | None = Form(default=None),
    width: int | None = Form(default=None),
    height: int | None = Form(default=None),
    fit: str = Form(default="inside"),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    if file.content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {file.content_type}")
    content = await file.read()
    try:
        converted, metadata = convert_image_bytes(
            content,
            file.filename or "image",
            file.content_type or "image/png",
            target_format=target_format,
            quality=quality,
            width=width,
            height=height,
            fit=fit,
        )
    except ValueError as error:
        status = 501 if "is not supported by this container image" in str(error) else 400
        raise HTTPException(status_code=status, detail=str(error)) from error

    return Response(
        converted,
        media_type=metadata["mimeType"],
        headers={
            "Content-Disposition": f'attachment; filename="{metadata["filename"]}"',
            "X-Aleph-Tools-Filename": metadata["filename"],
            "X-Aleph-Tools-Width": str(metadata["width"]),
            "X-Aleph-Tools-Height": str(metadata["height"]),
            "X-Aleph-Tools-Format": metadata["format"],
            "X-Aleph-Tools-Size-Bytes": str(metadata["sizeBytes"]),
        },
    )


@app.post("/internal/ocr/pdf")
async def ocr_pdf(
    file: UploadFile = File(...),
    mode: str = Query(default=DEFAULT_OCR_MODE),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {file.content_type}")
    content = await file.read()
    try:
        return JSONResponse(ocr_pdf_bytes(content, file.filename or "document.pdf", file.content_type, mode))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/internal/ocr/pdf-info")
async def pdf_info(
    request: Request,
    file: UploadFile | None = File(default=None),
    filename: str | None = Query(default=None),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    content, resolved_filename = await read_pdf_payload(request, file, filename)
    try:
        return JSONResponse(pdf_info_bytes(content, resolved_filename))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/internal/ocr/pdf-page")
async def ocr_pdf_page(
    page_index: int = 0,
    file: UploadFile = File(...),
    mode: str = Query(default=DEFAULT_OCR_MODE),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {file.content_type}")
    content = await file.read()
    try:
        return JSONResponse(ocr_pdf_page_bytes(content, file.filename or "document.pdf", page_index, mode))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/internal/ocr/pdf-batch")
async def ocr_pdf_batch(
    request: Request,
    start_page: int = Query(default=0, ge=0),
    page_count: int = Query(default=1, ge=1),
    mode: str = Query(default=DEFAULT_OCR_MODE),
    filename: str | None = Query(default=None),
    file: UploadFile | None = File(default=None),
    x_aleph_tools_internal_token: str | None = Header(default=None),
    x_aleph_ocr_internal_token: str | None = Header(default=None),
):
    check_internal_token(x_aleph_tools_internal_token or x_aleph_ocr_internal_token)
    content, resolved_filename = await read_pdf_payload(request, file, filename)
    try:
        return JSONResponse(ocr_pdf_batch_bytes(content, resolved_filename, "application/pdf", start_page, page_count, mode))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


async def read_pdf_payload(request: Request, file: UploadFile | None, filename: str | None) -> tuple[bytes, str]:
    if file is not None:
        if file.content_type != "application/pdf":
            raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {file.content_type}")
        return await file.read(), file.filename or filename or "document.pdf"

    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/pdf":
        raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {content_type or 'unknown'}")
    content = await request.body()
    return content, filename or request.headers.get("x-aleph-tools-filename") or "document.pdf"


def check_internal_token(provided: str | None) -> None:
    expected = os.getenv("TOOLS_ENGINE_TOKEN")
    if expected and provided != expected:
        raise HTTPException(status_code=401, detail="Invalid internal tools token")
