FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1     PADDLEOCR_HOME=/models/paddleocr     MAX_PDF_PAGES=100     PDF_BATCH_SIZE=5     PDF_RENDER_DPI=200

WORKDIR /app

RUN apt-get update     && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1     && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY scripts ./scripts
RUN chmod +x ./scripts/download-models.sh

EXPOSE 8090
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8090"]
