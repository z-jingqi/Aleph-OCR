from __future__ import annotations

import os

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .ocr_engine import engine_info, ocr_image_bytes, ocr_pdf_bytes, ocr_pdf_page_bytes

app = FastAPI(title="Aleph-OCR Engine", version="0.1.0")

SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp"}
MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024


@app.get("/health")
def health():
    return engine_info()


@app.post("/internal/ocr/image")
async def ocr_image(file: UploadFile = File(...), x_aleph_ocr_internal_token: str | None = Header(default=None)):
    check_internal_token(x_aleph_ocr_internal_token)
    if file.content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {file.content_type}")
    content = await file.read()
    if len(content) > MAX_SYNC_IMAGE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds sync OCR size limit")
    return JSONResponse(ocr_image_bytes(content, file.filename or "image", file.content_type or "image/png"))


@app.post("/internal/ocr/pdf")
async def ocr_pdf(file: UploadFile = File(...), x_aleph_ocr_internal_token: str | None = Header(default=None)):
    check_internal_token(x_aleph_ocr_internal_token)
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {file.content_type}")
    content = await file.read()
    try:
        return JSONResponse(ocr_pdf_bytes(content, file.filename or "document.pdf", file.content_type))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/internal/ocr/pdf-page")
async def ocr_pdf_page(page_index: int = 0, file: UploadFile = File(...), x_aleph_ocr_internal_token: str | None = Header(default=None)):
    check_internal_token(x_aleph_ocr_internal_token)
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail=f"Unsupported PDF type: {file.content_type}")
    content = await file.read()
    try:
        return JSONResponse(ocr_pdf_page_bytes(content, file.filename or "document.pdf", page_index))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def check_internal_token(provided: str | None) -> None:
    expected = os.getenv("OCR_ENGINE_TOKEN")
    if expected and provided != expected:
        raise HTTPException(status_code=401, detail="Invalid internal OCR token")
