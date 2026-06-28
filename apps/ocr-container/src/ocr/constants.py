import os

ENGINE = "paddleocr"
ENGINE_VERSION = "3.7.0"
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "100"))
PDF_BATCH_SIZE = int(os.getenv("PDF_BATCH_SIZE", "5"))
MAX_SYNC_IMAGE_SIZE_BYTES = 10 * 1024 * 1024
