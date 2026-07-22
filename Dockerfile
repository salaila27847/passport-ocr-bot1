# 1. ใช้ Python Base Image
FROM python:3.10-slim

# 2. ติดตั้ง Tesseract OCR และ dependencies สำหรับระบบ Linux
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libgl1-mesa-glx \
    libglib2.0-0 \
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