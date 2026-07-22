# 1. ใช้ Debian Bookworm Slim Base Image
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 2. ติดตั้ง Python3, Pip, Tesseract OCR และ C-Libraries ที่จำเป็น
RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
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

# 4. ติดตั้ง Python Packages ผ่าน pip
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# 5. คัดลอกโค้ดแอปพลิเคชันทั้งหมด
COPY . .

# 6. เปิด Port และสั่งรันแอปด้วย Gunicorn
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "120", "app:app"]