# 1. ใช้ Python Base Image
FROM python:3.10-slim

# ตั้งค่า Environment ไม่ให้ apt-get ถามโต้ตอบระหว่างติดตั้ง
ENV DEBIAN_FRONTEND=noninteractive

# 2. อัปเดตและติดตั้ง Tesseract OCR พร้อม dependencies
RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1 \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. กำหนด Working Directory
WORKDIR /app

# 4. ติดตั้ง Python Packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 5. คัดลอกโค้ดทั้งหมด
COPY . .

# 6. เปิด Port และสั่งรันแอปพลิเคชันด้วย Gunicorn
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "120", "app:app"]