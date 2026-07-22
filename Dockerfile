# 1. ใช้ Python Base Image
FROM python:3.10-slim

ENV DEBIAN_FRONTEND=noninteractive

# 2. ติดตั้ง Tesseract OCR และ System Libraries ที่จำเป็น
RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    gcc \
    g++ \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. กำหนด Working Directory
WORKDIR /app

# 4. ติดตั้ง Python Packages ล่วงหน้า
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir --no-deps passporteye==2.2.5

# 5. คัดลอกโค้ดทั้งหมด
COPY . .

# 6. เปิด Port และสั่งรันบริการ
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "120", "app:app"]