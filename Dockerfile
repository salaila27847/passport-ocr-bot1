# 1. ใช้ Debian Bookworm Slim Base Image
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 2. ติดตั้ง Python, Tesseract และ PassportEye ผ่าน apt โดยตรง
RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-passporteye \
    tesseract-ocr \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. กำหนด Working Directory
WORKDIR /app

# 4. ติดตั้งเฉพาะ Flask และ Gunicorn ผ่าน pip (ใช้ --break-system-packages สำหรับ Debian 12)
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# 5. คัดลอกโค้ดแอปพลิเคชันทั้งหมด
COPY . .

# 6. เปิด Port และสั่งรันแอปด้วย Gunicorn
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "120", "app:app"]