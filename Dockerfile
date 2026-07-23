FROM python:3.10-slim

# ติดตั้ง Tesseract OCR และ dependencies ที่จำเป็นในระบบ
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libtesseract-dev \
    ffmpeg \
    smbclient \
    libsmbclient-dev \
    && rm -rf /var/lib/apt-get/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# --timeout 120: เผื่อเวลาให้ Tesseract/PassportEye ประมวลผลรูปภาพขนาดใหญ่หรือคุณภาพต่ำได้
# โดยไม่ให้ gunicorn kill worker ก่อนเวลา (ค่า default คือ 30 วินาที ซึ่งน้อยเกินไปสำหรับงาน OCR)
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--timeout", "120", "app:app"]
