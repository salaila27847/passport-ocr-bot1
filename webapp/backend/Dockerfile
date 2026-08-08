FROM python:3.12-slim

# ติดตั้ง Tesseract OCR ที่ passporteye ต้องใช้ (เหมือน Dockerfile เดิมของ app.py ที่ root)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libtesseract-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PORT=8080
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
