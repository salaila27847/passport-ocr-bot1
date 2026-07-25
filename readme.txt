# Passport OCR Bot - คู่มือ Source Code ฉบับสมบูรณ์ (Server + Apps Script)

เอกสารนี้รวบรวม Source Code ทั้ง 2 ฝั่งของระบบ Passport OCR Bot ฉบับล่าสุด ซึ่งแก้ไขปัญหาแล้วทั้งหมด 3 บั๊ก และปรับสถาปัตยกรรม OCR เป็นแบบ **background processing** เพื่อไม่ให้ cold start ของ Render มาบล็อกการตอบ LINE:
1. การอ่านชื่อ-นามสกุลผิดพลาด (มีคำขยะจาก OCR ปนอยู่ เช่น `KKKKKGGGGG`, `KSKK`)
2. การส่งรูปภาพไปยัง OCR Server ล้มเหลวแบบไม่แน่นอน (multipart/form-data เสียหายจาก base64 padding)
3. บอทตอบ "ไม่เข้าใจข้อความ" หลังกรอก Flight No. เสร็จแล้วพิมพ์หมายเลข SEQ ถัดไป
4. **(ใหม่) OCR แบบ Background:** ถ่ายรูป Passport แล้วไม่ต้องรอผลลัพธ์ ไปทำ SEQ อื่นต่อได้ทันที แล้วค่อยกดปุ่ม "นำเข้าข้อมูล" ภายหลัง — แก้ปัญหา cold start ของ Render ไม่ให้บล็อกเจ้าหน้าที่

## สารบัญ
1. [สรุปปัญหาและวิธีแก้](#สรุปปัญหาและวิธีแก้)
2. [สถาปัตยกรรม OCR แบบ Background (ใหม่)](#สถาปัตยกรรม-ocr-แบบ-background-ใหม่)
3. [ฝั่ง Server (Render / Python)](#ฝั่ง-server-render--python)
4. [ฝั่ง Apps Script (Google Sheets / LINE Bot)](#ฝั่ง-apps-script-google-sheets--line-bot)
5. [ขั้นตอนการ Deploy](#ขั้นตอนการ-deploy)
6. [ประวัติการแก้ไข (Changelog)](#ประวัติการแก้ไข-changelog)

---

## สรุปปัญหาและวิธีแก้

### ปัญหาที่พบ
เมื่อถ่ายรูปพาสปอร์ต ระบบอ่านชื่อ-นามสกุลได้ไม่ถูกต้อง เช่น จริงๆ ควรเป็น `YUBIN ZHANG` แต่ระบบอ่านได้ `YUBIN KKKKKGGGGG KSKK ZHANG`

### ต้นเหตุ
`PassportEye` (ไลบรารีที่ใช้อ่านแถบ MRZ ของพาสปอร์ต) ใช้ Tesseract OCR อ่านตัวอักษรจากแถบ MRZ แล้วตัดคำด้วยตัวคั่น `<` โดย**ไม่มีการกรองคำขยะใดๆ เลย** หากภาพมีรอยเปื้อน รอยยับ หรือแสงสะท้อนบนแถบ MRZ, Tesseract อาจอ่านผิดเป็นตัวอักษรซ้ำๆ กัน (เช่น `KKKKK`, `GGGGG`) ซึ่งจะติดมาในผลลัพธ์ `given_names` โดยตรง

### วิธีแก้ (แก้ 2 ชั้น เพื่อความชัวร์)

**ชั้นที่ 1 — ฝั่ง Server (`app.py`):**
- เพิ่มฟังก์ชัน `clean_name_field()` กรองคำขยะออกตั้งแต่ต้นทาง ก่อนส่งข้อมูลออกจาก Server
- เพิ่ม logic ใช้ค่า `valid_score` (คะแนนความมั่นใจของการอ่าน MRZ) ตัดสินใจ — ถ้าอ่านครั้งแรกได้คะแนนต่ำกว่า 70 จะลองอ่านซ้ำด้วยภาพที่ปรับปรุงคุณภาพ (resize/contrast/sharpen) แล้วเลือกผลที่คะแนนดีกว่า

**ชั้นที่ 2 — ฝั่ง Apps Script (`Code.gs`):**
- เพิ่มฟังก์ชัน `isNoiseToken()` กรองคำขยะซ้ำอีกชั้น (กันเหนียว เผื่อ Server เวอร์ชันเก่ายังไม่ได้อัปเดต) โดยใช้ 2 กติกา:
  1. คำที่มีตัวอักษรเดียวกันซ้ำติดกันตั้งแต่ 3 ตัวขึ้นไป (เช่น `KKK`, `GGGG`) → ถือเป็นขยะ
  2. คำที่ยาว ≥ 3 ตัวอักษร แต่ไม่มีสระเลย (A E I O U Y) → ถือเป็นขยะ (ชื่อคนจริงแทบทั้งหมดมีสระ)
- นำตัวกรองนี้ไปใช้ทั้งกับ VIZ parsing (`given_names`, `surname` จากหน้าพาสปอร์ต) และ MRZ parsing (จากแถบล่างพาสปอร์ต)

### ปัญหาที่ 2: ส่งรูปไป OCR Server ล้มเหลวแบบสุ่ม (บางครั้งผ่าน บางครั้งไม่ผ่าน)

**ต้นเหตุ:** ในฟังก์ชัน `callExternalPassportOcr()` (Apps Script) โค้ดสร้าง multipart/form-data โดยเข้ารหัส base64 แยกท่อน `header`, รูปภาพ, `footer` แล้วนำสตริง base64 มาต่อกันก่อน decode รวมทีเดียว วิธีนี้ผิดหลักการ base64 เพราะแต่ละท่อนจะมี padding (`=`) ท้ายสตริงถ้าความยาวไม่ลงตัวกับ 3 ไบต์ พอเอามาต่อกันแล้ว decode รวม เครื่องหมาย `=` ที่แทรกอยู่กลางสตริงจะทำให้ไฟล์ภาพเสียหายก่อนถึง Server เนื่องจากความยาวของ `header` ขึ้นกับความยาวชื่อไฟล์ (`SEQ001_...` vs `SEQ012_...`) ซึ่งไม่เท่ากันในแต่ละครั้ง จึงเกิดอาการผ่านบ้างไม่ผ่านบ้างแบบสุ่ม

**วิธีแก้:** เปลี่ยนจากการต่อสตริง base64 มาต่อไบต์อาเรย์ (`getBytes()`) ตรงๆ ด้วย `.concat()` ซึ่ง Apps Script รองรับอยู่แล้ว ไม่ต้องผ่าน base64 เลย จึงไม่มีปัญหา padding แทรกกลางข้อมูลอีกต่อไป

### ปัญหาที่ 3: บอทตอบ "ไม่เข้าใจข้อความ" หลังกรอก Flight No. เสร็จ

**ต้นเหตุ:** ในขั้นตอนกรอก Flight No. หลังจากจอง SEQ กลุ่ม (ส่วน 4.2 ของ `handleEvent()`) โค้ดส่งข้อความชวนให้ผู้ใช้พิมพ์หมายเลข SEQ ถัดไป แต่ลืมตั้งค่า flag `_awaitingSeq` เป็น `'true'` ก่อน ทำให้ตัวเช็ค "อยู่ในขั้นตอนรอรับหมายเลข SEQ" (ส่วน 4.6) ไม่ทำงาน ข้อความ SEQ ที่พิมพ์เข้ามาจึงไม่ตรงเงื่อนไขใดเลยและตกไปที่ข้อความ fallback "ไม่เข้าใจข้อความ"

**วิธีแก้:** เพิ่ม `userProperties.setProperty(userId + '_awaitingSeq', 'true')` เข้าไปในขั้นตอนกรอก Flight No. สำเร็จ ก่อนส่งข้อความชวนพิมพ์ SEQ ให้สอดคล้องกับจุดอื่นๆ ในโค้ดที่ทำแบบเดียวกัน

---

## สถาปัตยกรรม OCR แบบ Background (ใหม่)

**ปัญหาเดิม:** ตอนถ่ายรูป Passport บอทจะยิงรูปไป Render แบบ synchronous แล้วรอผลลัพธ์ OCR ก่อนตอบ LINE กลับ ถ้า Render กำลังหลับ (free tier) เจ้าหน้าที่ต้องรอ 30-50 วิถึงจะทำ SEQ ถัดไปได้

**แนวทางแก้:** แยกขั้นตอน "ส่งรูปไปประมวลผล" กับ "นำผลมาใช้" ออกจากกัน โดยใช้ Google Sheet เป็นที่พักผลลัพธ์ (ไม่ต้องเพิ่มฐานข้อมูลแยก):

```
[LINE] ถ่ายรูป Passport
   │
   ▼
[Code.gs] submitPassportOcrAsync() → POST /ocr/submit (ไม่รอผล)
   │                                        │
   ▼                                        ▼
ตอบ LINE ทันที:                    [app.py] spawn background thread
"ส่งไปประมวลผลแล้ว                        │ รัน run_ocr_pipeline()
 ไปทำ SEQ อื่นต่อได้เลย"                    │ (2-5 วิ)
 + ปุ่ม "📥 นำเข้าข้อมูล"                    ▼
                                    POST callback กลับมาที่
                                    Code.gs doPost()
                                    (action=ocr_callback)
                                            │
                                            ▼
                                    handleOcrCallback()
                                    เขียนผลลง แท็บ OCR_RESULTS
                                    (SEQ ซ้ำ = overwrite ทับแถวเดิม)

[เจ้าหน้าที่กดปุ่ม "📥 นำเข้าข้อมูล"] → importOcrResult()
   │
   ▼
ค้นแถวใน OCR_RESULTS ตาม SEQ
   ├─ ไม่เจอ/ยังไม่เสร็จ → แจ้งว่ารออีกสักครู่
   ├─ Status = error → แจ้ง error ให้ถ่ายใหม่
   └─ Status = done → เขียนลง SUMMARY เหมือน flow เดิม
        + ขีดฆ่าแถวใน OCR_RESULTS + ใส่ "imported" คอลัมน์สุดท้าย
```

**โครงสร้างแท็บ `OCR_RESULTS`** (สร้างอัตโนมัติถ้ายังไม่มี):

| SEQ | Timestamp | Status | Nationality | PassportNo | Sex | RegexName | PassportEyeName | Remark | ImportStatus |
|---|---|---|---|---|---|---|---|---|---|
| 105 | 25/07/2026 14:32:10 | done | THA | AA1234567 | M | SURAT... | SURAT... | | pending |

- **Status:** `done` = อ่าน OCR สำเร็จ, `error` = อ่านไม่สำเร็จ (ดูสาเหตุที่คอลัมน์ Remark)
- **ImportStatus:** `pending` = ยังไม่ได้กดนำเข้า, `imported` = นำเข้าแล้ว (แถวจะถูกขีดฆ่า)
- ถ้าถ่ายรูป SEQ เดิมซ้ำ (ภาพแรกไม่ชัด) ระบบจะ **overwrite ทับแถวเดิมของ SEQ นั้น** ไม่สร้างแถวใหม่ และล้างขีดฆ่าเดิมออกอัตโนมัติ

**Endpoint ใหม่ฝั่ง `app.py`:**
- `POST /ocr/submit` — รับ `image` + `seq` + `sheetId` (multipart/form-data) → ตอบ `202 Accepted` ทันที → ประมวลผล OCR ใน background thread → ยิง callback กลับไป Apps Script
- `POST /ocr` และ `/ocr/passport` เดิมยังคงอยู่ (แบบ synchronous) ไว้ใช้ทดสอบหรือเรียกตรงได้เหมือนเดิม ไม่ได้ใช้งานจาก `Code.gs` แล้ว

**ตัวแปรที่ต้องตั้งค่าเพิ่มบน Render (Environment Variables):**
- `APPS_SCRIPT_WEBHOOK_URL` — URL ของ Apps Script Web App ที่ deploy ไว้ (ลงท้ายด้วย `/exec`)
- `APPS_SCRIPT_TOKEN` — ต้องมีค่าเดียวกับ `SECRET_TOKEN` ใน `Code.gs`

---



### `requirements.txt`

```txt
Flask==3.0.0
gunicorn==21.2.0
passporteye==2.2.2
Pillow==10.2.0
requests==2.31.0
```

### `app.py`

```python
import os
import re
import tempfile
import threading
import requests
from flask import Flask, request, jsonify
from passporteye import read_mrz
from PIL import Image, ImageEnhance, ImageFilter

app = Flask(__name__)

MIN_ACCEPTABLE_SCORE = 70
MAX_DIMENSION = 1800
VOWELS = set("AEIOUY")

# ต้องตรงกับ SECRET_TOKEN และ URL ของ Apps Script Web App ที่ deploy ไว้
APPS_SCRIPT_WEBHOOK_URL = os.environ.get("APPS_SCRIPT_WEBHOOK_URL", "")
APPS_SCRIPT_TOKEN = os.environ.get("APPS_SCRIPT_TOKEN", "hkt12345604")


def downscale_if_needed(src_path: str, dest_path: str) -> str:
    img = Image.open(src_path)
    width, height = img.size
    longest_side = max(width, height)

    if longest_side <= MAX_DIMENSION:
        return src_path

    scale = MAX_DIMENSION / longest_side
    new_size = (int(width * scale), int(height * scale))
    img = img.resize(new_size, Image.Resampling.LANCZOS)
    img.save(dest_path, quality=90)
    return dest_path


def is_noise_token(word: str) -> bool:
    if not word:
        return True
    if re.search(r"(.)\1{2,}", word):
        return True
    if len(word) >= 3 and not any(ch in VOWELS for ch in word):
        return True
    return False


def clean_name_field(raw: str) -> str:
    if not raw:
        return ""
    words = re.split(r"[<\s]+", str(raw).upper())
    cleaned = []
    for w in words:
        w = re.sub(r"[^A-Z]", "", w)
        if len(w) >= 2 and not is_noise_token(w):
            cleaned.append(w)
    return " ".join(cleaned)


def parse_mrz_line1_regex(line1_text: str):
    """สกัด Surname และ Given Names จาก MRZ Line 1 ด้วย Regex"""
    if not line1_text:
        return "", ""

    clean_line = line1_text.upper()
    clean_line = re.sub(r'[\«\«»]', '<<', clean_line)
    clean_line = re.sub(r'[«»]', '<', clean_line)
    clean_line = re.sub(r'[^A-Z0-9<]', '', clean_line)

    if len(clean_line) > 5 and clean_line.startswith('P'):
        name_segment = clean_line[5:]
    else:
        name_segment = clean_line

    parts = name_segment.split('<<')
    surname = clean_name_field(parts[0]) if len(parts) > 0 else ""
    given_names = clean_name_field(parts[1].replace('<', ' ')) if len(parts) > 1 else ""

    return surname, given_names


def enhance_image(src_path: str, dest_path: str) -> None:
    img = Image.open(src_path)
    width, height = img.size
    longest_side = max(width, height)

    if longest_side < 1000:
        img = img.resize((width * 2, height * 2), Image.Resampling.LANCZOS)

    img = ImageEnhance.Contrast(img).enhance(2.0)
    img = ImageEnhance.Sharpness(img).enhance(2.0)
    img.save(dest_path, quality=95)


def run_ocr_pipeline(ocr_input_path: str):
    """รัน MRZ OCR บนไฟล์ภาพที่ path ที่กำหนด คืนค่า (success, data_dict_or_error_message)"""
    try:
        mrz = read_mrz(ocr_input_path)
        best_score = getattr(mrz, "valid_score", 0) if mrz is not None else -1

        if mrz is None or best_score < MIN_ACCEPTABLE_SCORE:
            enhanced_path = None
            try:
                enhanced_path = ocr_input_path + "_enh.jpg"
                enhance_image(ocr_input_path, enhanced_path)
                mrz_enhanced = read_mrz(enhanced_path)
                enhanced_score = getattr(mrz_enhanced, "valid_score", 0) if mrz_enhanced is not None else -1
                if enhanced_score > best_score:
                    mrz = mrz_enhanced
                    best_score = enhanced_score
            except Exception as img_err:
                print(f"Image enhancement failed: {img_err}")
            finally:
                if enhanced_path and os.path.exists(enhanced_path):
                    os.remove(enhanced_path)

        if mrz is None:
            return False, "Could not detect or read MRZ zone in the image"

        mrz_data = mrz.to_dict()
        raw_text = getattr(mrz, "raw_text", "") or ""
        lines = [l.strip() for l in raw_text.split('\n') if l.strip()]

        passport_num = mrz_data.get("number") or mrz_data.get("passport_number") or ""

        # 1. Names via PassportEye
        pe_surname = clean_name_field(mrz_data.get("surname") or "")
        raw_given_names = (
            mrz_data.get("names")
            or mrz_data.get("given_name")
            or mrz_data.get("given_names")
            or ""
        )
        pe_given_names = clean_name_field(raw_given_names)
        pe_full_name = f"{pe_given_names} {pe_surname}".strip()

        # 2. Names via Regex (MRZ Line 1)
        line1 = lines[0] if len(lines) > 0 else ""
        regex_surname, regex_given_names = parse_mrz_line1_regex(line1)
        regex_full_name = f"{regex_given_names} {regex_surname}".strip()

        # 3. Country & Nationality Logic
        line2 = lines[1] if len(lines) > 1 else ""
        issuing_country = mrz_data.get("country") or (line1[2:5] if len(line1) >= 5 else '')
        nationality = line2 if len(line2) >= 13 else (mrz_data.get("nationality") or "")

        nationality_mismatch = False
        remark = ""
        if issuing_country and nationality and (issuing_country != nationality):
            nationality_mismatch = True
            remark = "⚠️ สัญชาติไม่ตรงกับประเทศผู้ออกเล่ม"

        sex = mrz_data.get("sex") or ""

        data = {
            "raw_text": raw_text,
            "valid_score": best_score,
            "passport_number": passport_num,
            "date_of_birth": mrz_data.get("date_of_birth"),
            "expiration_date": mrz_data.get("expiration_date"),
            "issuing_country": issuing_country,
            "nationality": nationality,
            "nationality_mismatch": nationality_mismatch,
            "remark": remark,
            "surname": pe_surname,
            "given_names": pe_given_names,
            "regex_full_name": regex_full_name,
            "passporteye_full_name": pe_full_name,
            "sex": sex
        }
        return True, data

    except Exception as e:
        return False, str(e)


def process_ocr_job_background(temp_path: str, ocr_input_path: str, seq: str, sheet_id: str):
    """งานเบื้องหลัง: รัน OCR แล้วยิงผลลัพธ์กลับไปที่ Apps Script webhook"""
    try:
        success, result = run_ocr_pipeline(ocr_input_path)

        callback_payload = {
            "action": "ocr_callback",
            "seq": seq,
            "sheetId": sheet_id,
            "success": success,
        }
        if success:
            callback_payload["data"] = result
        else:
            callback_payload["error"] = result

        if not APPS_SCRIPT_WEBHOOK_URL:
            print("APPS_SCRIPT_WEBHOOK_URL not configured; skipping callback")
            return

        try:
            requests.post(
                f"{APPS_SCRIPT_WEBHOOK_URL}?token={APPS_SCRIPT_TOKEN}",
                json=callback_payload,
                timeout=20
            )
        except Exception as cb_err:
            print(f"Callback POST to Apps Script failed: {cb_err}")

    finally:
        for p in {temp_path, ocr_input_path}:
            if p and os.path.exists(p):
                os.remove(p)


@app.route('/ocr/submit', methods=['POST'])
def submit_passport_ocr():
    """รับรูป + seq + sheetId แล้วประมวลผล OCR แบบ background ไม่บล็อกการตอบกลับ"""
    if 'image' not in request.files:
        return jsonify({"success": False, "error": "No image file provided"}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400

    seq = request.form.get('seq', '').strip()
    sheet_id = request.form.get('sheetId', '').strip()
    if not seq or not sheet_id:
        return jsonify({"success": False, "error": "Missing seq or sheetId"}), 400

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as ds_file:
            ds_candidate = ds_file.name
        ocr_input_path = downscale_if_needed(temp_path, ds_candidate)
        if ocr_input_path != ds_candidate:
            os.remove(ds_candidate)

        thread = threading.Thread(
            target=process_ocr_job_background,
            args=(temp_path, ocr_input_path, seq, sheet_id),
            daemon=True
        )
        thread.start()

        return jsonify({"success": True, "message": "queued", "seq": seq}), 202

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "online",
        "message": "PassportEye OCR Service is ready!"
    }), 200


@app.route('/ocr', methods=['POST'])
@app.route('/ocr/passport', methods=['POST'])
def process_passport():
    if 'image' not in request.files:
        return jsonify({"success": False, "error": "No image file provided"}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400

    temp_path = None
    downscaled_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as ds_file:
            ds_candidate = ds_file.name
        ocr_input_path = downscale_if_needed(temp_path, ds_candidate)
        if ocr_input_path == ds_candidate:
            downscaled_path = ds_candidate
        else:
            os.remove(ds_candidate)

        success, result = run_ocr_pipeline(ocr_input_path)
        if not success:
            return jsonify({"success": False, "error": result}), 422

        return jsonify({"success": True, "data": result}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        if downscaled_path and os.path.exists(downscaled_path):
            os.remove(downscaled_path)
```

### `Dockerfile`

```dockerfile
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
```

---

## ฝั่ง Apps Script (Google Sheets / LINE Bot)

### `Code.gs`

```javascript
// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const CHANNEL_ACCESS_TOKEN = "bz73HKOFQeIFsYN0SzYyMOjiIgPAXFq1xvStsRa2ps3xN/8IrY5TUF0k6WaqgV5s1WOHarEgJPvX1BTzvEh3sKSSwbmm2JuA6YsykbbDm+mNjSm4kRoBbVtAXyJL/JPWCpy/JWu4T7kw5N0rJB4EfAdB04t89/1O/w1cDnyilFU=";
const MAIN_FOLDER_NAME = "interview";
const RENDER_OCR_URL = "https://passport-ocr-bot1.onrender.com/ocr";
const RENDER_OCR_SUBMIT_URL = "https://passport-ocr-bot1.onrender.com/ocr/submit";
const SECRET_TOKEN = "hkt12345604";

// ==========================================
// MAIN WEBHOOK (doPost)
// ==========================================
function doPost(e) {
  try {
    if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const body = JSON.parse(e.postData.contents);

    // Callback จาก app.py หลังประมวลผล OCR แบบ background เสร็จ
    if (body.action === 'ocr_callback') {
      handleOcrCallback(body);
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const events = body.events || [];
    for (const event of events) {
      handleEvent(event);
    }
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('doPost Error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// EVENT HANDLER
// ==========================================
function handleEvent(event) {
  const userId = event.source.userId;
  const userProperties = PropertiesService.getUserProperties();

  if (isResetCommand(event)) {
    clearAllUserProperties(userProperties, userId);
    sendSheetFlexMenu(event.replyToken);
    return;
  }

  if (isStopCommand(event)) {
    clearAllUserProperties(userProperties, userId);
    replyText(event.replyToken, '🛑 หยุดการใช้งานเรียบร้อยแล้ว\n\nหากต้องการกลับมาใช้งานใหม่ พิมพ์ "EXIT" หรือส่งสติ๊กเกอร์เข้ามาได้เลยครับ');
    return;
  }

  // 1. จัดการเมื่อผู้ใช้ส่งรูปภาพ
  if (event.type === 'message' && event.message.type === 'image') {
    const sheetId = userProperties.getProperty(userId + '_sheetId');
    const seq = userProperties.getProperty(userId + '_seq');

    if (!sheetId || !seq) {
      replyText(event.replyToken, '⚠️ กรุณาเลือกแผ่นงาน Google Sheets และกำหนดเลข SEQ ก่อนส่งรูปภาพครับ');
      return;
    }

    sendImageClassificationMenu(event.replyToken, event.message.id);
    return;
  }

  // 2. จัดการการกดปุ่ม (Postback Event)
  if (event.type === 'postback') {
    const data = parseQueryString(event.postback.data);

    // เลือกแผ่นงาน Sheets
    if (data.action === 'select_sheet') {
      userProperties.setProperty(userId + '_sheetId', data.sheetId);
      userProperties.setProperty(userId + '_sheetName', data.sheetName);
      userProperties.deleteProperty(userId + '_seq');
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      replySeqPromptWithBookingOption(
        event.replyToken,
        `📊 คุณเลือกแผ่นงาน: "${data.sheetName}"\n\nกรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ หรือกดปุ่ม "จอง SEQ" ด้านล่าง:`
      );
      return;
    }

    // ระบุประเภทภาพถ่าย
    if (data.action === 'classify_image') {
      handleImageClassification(event, userId, data.msgId, data.type);
      return;
    }

    // จบงาน / สรุปข้อมูล
    if (data.action === 'finish_case') {
      showSummaryAndNameOptions(event, userId);
      return;
    }

    // ยืนยันการเลือกชื่อ
    if (data.action === 'confirm_name_selection') {
      saveFinalNameAndComplete(event, userId, data.choice);
      return;
    }

    // นำเข้าผลลัพธ์ OCR ที่ประมวลผลเสร็จแล้วจากแท็บ OCR_RESULTS
    if (data.action === 'import_ocr') {
      importOcrResult(event, userId, data.seq);
      return;
    }

    // Quick Reply Menu Actions หลังจบงาน
    if (data.action === 'menu_select_seq') {
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      replyText(event.replyToken, "📸 กรุณากรอกเลข SEQ สำหรับเคสถัดไป (เช่น 02 หรือ 105):");
      return;
    }

    if (data.action === 'menu_reserve_seq' || data.action === 'book_seq') {
      userProperties.setProperty(userId + '_awaitingBookingCount', 'true');
      userProperties.deleteProperty(userId + '_awaitingSeq');
      replyText(event.replyToken, '📌 ต้องการจอง SEQ กี่คนครับ? (กรุณากรอกตัวเลข เช่น 1, 2, 3)');
      return;
    }

    if (data.action === 'menu_end') {
      clearAllUserProperties(userProperties, userId);
      replyText(event.replyToken, "🏁 ปิดการทำงานเรียบร้อยแล้ว หากต้องการเริ่มใหม่ สามารถกดเลือกเมนูหรือพิมพ์ EXIT ได้เลยครับ");
      return;
    }
  }

  // 3. จัดการเมื่อผู้ใช้ส่งข้อความ (Text Event)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const currentSheetId = userProperties.getProperty(userId + '_sheetId');

    if (!currentSheetId) {
      sendSheetFlexMenu(event.replyToken);
      return;
    }

    // อยู่ในขั้นตอนกรอกจำนวนคนจอง SEQ
    const awaitingBookingCount = userProperties.getProperty(userId + '_awaitingBookingCount') === 'true';
    if (awaitingBookingCount) {
      const count = parseInt(text, 10);
      if (isNaN(count) || count <= 0) {
        replyText(event.replyToken, '⚠️ กรุณากรอกจำนวนเป็นตัวเลขมากกว่า 0 ครับ (เช่น 1, 2, 3)');
        return;
      }
      try {
        const userName = getLineUserProfile(userId);
        const bookedSeqs = processBookingInSummarySheet(currentSheetId, count, userName);
        userProperties.deleteProperty(userId + '_awaitingBookingCount');
        userProperties.setProperty(userId + '_pendingFlightSeqs', JSON.stringify(bookedSeqs));
        replyText(
          event.replyToken,
          `✅ **รับยอดจอง SEQ เรียบร้อยแล้ว!**\n• ผู้จอง: ${userName}\n• จำนวน: ${count} คน\n• ได้รับ SEQ: ${bookedSeqs.join(', ')}\n\n✈️ กรุณากรอก Flight No. สำหรับการเดินทางกลุ่มนี้:`
        );
      } catch (err) {
        console.error('Booking Error: ' + err);
        replyText(event.replyToken, `❌ ${err.message || 'เกิดข้อผิดพลาดในการจอง SEQ'}`);
      }
      return;
    }

    // อยู่ในขั้นตอนกรอก Flight No.
    const pendingFlightSeqsStr = userProperties.getProperty(userId + '_pendingFlightSeqs');
    if (pendingFlightSeqsStr) {
      const formattedFlightNo = formatFlightNo(text);
      try {
        const bookedSeqs = JSON.parse(pendingFlightSeqsStr);
        updateFlightNoInSummarySheet(currentSheetId, bookedSeqs, formattedFlightNo);
        userProperties.deleteProperty(userId + '_pendingFlightSeqs');
        userProperties.setProperty(userId + '_awaitingSeq', 'true');
        const seqListStr = bookedSeqs.map(s => `• SEQ ${s}`).join('\n');
        replySeqPromptWithBookingOption(
          event.replyToken,
          `🎉 **สรุปการจองสำเร็จ!**\n\n✈️ **Flight No.:** ${formattedFlightNo}\n📋 **รายการ SEQ ที่จอง (${bookedSeqs.length} คน):**\n${seqListStr}\n\n---------------------------\nกรุณาพิมพ์หมายเลข SEQ ที่ต้องการถ่ายรูปจัดการต่อได้เลยครับ:`
        );
      } catch (err) {
        console.error('Save Flight Error: ' + err);
        replyText(event.replyToken, `❌ เกิดข้อผิดพลาดในการบันทึก Flight No.: ${err.message}`);
      }
      return;
    }

    // อยู่ในขั้นตอนรอรับหมายเลข SEQ
    const awaitingSeq = userProperties.getProperty(userId + '_awaitingSeq') === 'true';
    if (awaitingSeq) {
      userProperties.setProperty(userId + '_seq', text);
      userProperties.deleteProperty(userId + '_awaitingSeq');
      replyText(event.replyToken, `📸 กำหนด SEQ: [ ${text} ] เรียบร้อยแล้ว\n\nคุณสามารถกดเลือกถ่ายรูป/ส่งรูปภาพเข้ามาได้รวดเดียวเลยครับ`);
      return;
    }

    replyChangeSeqPrompt(event.replyToken, `❓ ไม่เข้าใจข้อความ "${text}" ครับ\nหากต้องการเปลี่ยนหรือจบ SEQ ปัจจุบัน กดปุ่มด้านล่างได้เลย หรือพิมพ์ "EXIT" เพื่อเลือกแผ่นงานใหม่ / พิมพ์ "STOP" เพื่อหยุดทำงาน`);
  }
}

// ==========================================
// 📸 Image Handling & Single-Click Classification
// ==========================================
function sendImageClassificationMenu(replyToken, msgId) {
  const flexMessage = {
    "type": "flex",
    "altText": "กรุณาระบุประเภทเอกสาร",
    "contents": {
      "type": "bubble",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          { "type": "text", "text": "📌 ระบุประเภทเอกสารสำหรับรูปนี้", "weight": "bold", "size": "sm" },
          {
            "type": "box",
            "layout": "grid",
            "cols": 2,
            "margin": "md",
            "spacing": "sm",
            "contents": [
              { "type": "button", "style": "primary", "height": "sm", "action": { "type": "postback", "label": "📘 Passport", "data": `action=classify_image&type=PASSPORT&msgId=${msgId}` } },
              { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "✈️ Ticket", "data": `action=classify_image&type=Return Ticket&msgId=${msgId}` } },
              { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "🏨 Hotel", "data": `action=classify_image&type=Accomodation&msgId=${msgId}` } },
              { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "📁 ETC", "data": `action=classify_image&type=ETC&msgId=${msgId}` } }
            ]
          },
          { "type": "separator", "margin": "lg" },
          {
            "type": "button",
            "style": "link",
            "color": "#FF3B30",
            "action": { "type": "postback", "label": "🏁 จบงาน / สรุปข้อมูล", "data": "action=finish_case" }
          }
        ]
      }
    }
  };
  sendLineReply(replyToken, [flexMessage]);
}

function handleImageClassification(event, userId, msgId, photoType) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const sheetName = userProperties.getProperty(userId + '_sheetName');
  const seq = userProperties.getProperty(userId + '_seq');

  try {
    const targetRow = findSeqRowInSheet(sheetId, seq);
    if (targetRow === -1) {
      replyText(event.replyToken, `❌ ไม่พบหมายเลข SEQ "${seq}" ในคอลัมน์ A ของแท็บ PHOTO`);
      return;
    }

    const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
    const passNo = userProperties.getProperty(userId + '_PASSPORT_NO') || 'NO_PASS';
    const fileName = `${seq}_${photoType}_${passNo}.jpg`;

    deleteExistingDriveFile(folder, fileName);
    const imageBlob = getImageBlobFromLine(msgId);
    imageBlob.setName(fileName);

    const file = folder.createFile(imageBlob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;

    saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl);

    if (photoType === 'PASSPORT') {
      const queued = submitPassportOcrAsync(sheetId, seq, imageBlob);
      if (queued) {
        replyOcrQueuedMessage(event.replyToken, seq);
      } else {
        replyText(event.replyToken, `⚠️ บันทึกรูป [Passport] แล้ว แต่ส่งไปประมวลผล OCR ไม่สำเร็จ\nลองกดปุ่ม "🔢 เปลี่ยน SEQ" แล้วเลือก SEQ นี้ใหม่เพื่อถ่ายซ้ำ`);
      }
    } else {
      replyText(event.replyToken, `✅ บันทึกรูปภาพเป็น [${photoType}] เรียบร้อยแล้ว`);
    }
  } catch (err) {
    console.error('Classification error: ' + err);
    replyText(event.replyToken, `❌ เกิดข้อผิดพลาด: ${err.message}`);
  }
}

// ==========================================
// 🔍 OCR (แบบ Background) & SUMMARY TAB LOGIC
// ==========================================

// ส่งรูป Passport ไปประมวลผล OCR แบบ background ที่ app.py (ไม่รอผลลัพธ์)
function submitPassportOcrAsync(sheetId, seq, imageBlob) {
  try {
    const boundary = "---------------------------" + new Date().getTime().toString(16);
    const filename = imageBlob.getName() || "passport.jpg";
    const contentType = imageBlob.getContentType() || "image/jpeg";
    const bytes = imageBlob.getBytes();

    const seqField = `--${boundary}\r\nContent-Disposition: form-data; name="seq"\r\n\r\n${seq}\r\n`;
    const sheetIdField = `--${boundary}\r\nContent-Disposition: form-data; name="sheetId"\r\n\r\n${sheetId}\r\n`;
    const imageHeader = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const seqFieldBytes = Utilities.newBlob(seqField).getBytes();
    const sheetIdFieldBytes = Utilities.newBlob(sheetIdField).getBytes();
    const imageHeaderBytes = Utilities.newBlob(imageHeader).getBytes();
    const footerBytes = Utilities.newBlob(footer).getBytes();

    // ต่อไบต์อาเรย์ตรงๆ ทุกส่วน ไม่ผ่าน base64 เลย (กันปัญหา padding แทรกกลางแบบที่เคยเจอ)
    const payload = seqFieldBytes.concat(sheetIdFieldBytes).concat(imageHeaderBytes).concat(bytes).concat(footerBytes);

    const options = {
      method: "post",
      contentType: "multipart/form-data; boundary=" + boundary,
      payload: payload,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(RENDER_OCR_SUBMIT_URL, options);
    const code = response.getResponseCode();
    return code === 202 || code === 200;
  } catch (err) {
    console.error("submitPassportOcrAsync Exception: " + err.toString());
    return false;
  }
}

function replyOcrQueuedMessage(replyToken, seq) {
  const message = {
    type: 'text',
    text: `📤 ส่งรูป Passport (SEQ ${seq}) ไปประมวลผล OCR แล้ว\nระบบใช้เวลาสักครู่ ไปทำ SEQ อื่นต่อได้เลยครับ\n\nพร้อมแล้วกดปุ่มด้านล่างเพื่อดึงผลลัพธ์:`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: `📥 นำเข้าข้อมูล SEQ ${seq}`,
            data: `action=import_ocr&seq=${seq}`,
            displayText: `นำเข้าข้อมูล SEQ ${seq}`
          }
        }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

// เรียกจาก doPost เมื่อ app.py ประมวลผล OCR เสร็จและยิง callback กลับมา
function handleOcrCallback(payload) {
  const seq = payload.seq;
  const sheetId = payload.sheetId;
  if (!seq || !sheetId) {
    console.error('ocr_callback missing seq/sheetId: ' + JSON.stringify(payload));
    return;
  }

  const ocrSheet = getOrCreateOcrResultsSheet(sheetId);
  const data = ocrSheet.getDataRange().getValues();

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(seq).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  if (rowIndex === -1) {
    rowIndex = ocrSheet.getLastRow() + 1;
  }

  const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");
  let rowValues;

  if (payload.success && payload.data) {
    const d = payload.data;
    const passportNo = d.passport_number ? String(d.passport_number).replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim() : '';
    rowValues = [
      seq, timestamp, 'done',
      d.nationality || '', passportNo, d.sex || '',
      d.regex_full_name || '', d.passporteye_full_name || '',
      d.remark || '', 'pending'
    ];
  } else {
    rowValues = [
      seq, timestamp, 'error', '', '', '', '', '',
      payload.error || 'OCR failed', 'pending'
    ];
  }

  const targetRange = ocrSheet.getRange(rowIndex, 1, 1, 10);
  targetRange.setValues([rowValues]);
  // ล้างขีดฆ่าเดิม เผื่อแถวนี้เคยถูก import ไปแล้วก่อนหน้า (กรณีถ่ายซ้ำ/SEQ ซ้ำ ให้ overwrite ทับ)
  targetRange.setFontLine('none');
}

function getOrCreateOcrResultsSheet(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName('OCR_RESULTS');
  if (!sheet) {
    sheet = ss.insertSheet('OCR_RESULTS');
    const headers = ['SEQ', 'Timestamp', 'Status', 'Nationality', 'PassportNo', 'Sex', 'RegexName', 'PassportEyeName', 'Remark', 'ImportStatus'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

// เรียกจากปุ่ม "📥 นำเข้าข้อมูล" — ดึงผล OCR จากแท็บ OCR_RESULTS มาบันทึกลง SUMMARY
function importOcrResult(event, userId, seq) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');

  if (!sheetId) {
    replyText(event.replyToken, '⚠️ ไม่พบแผ่นงานที่กำลังใช้งาน กรุณาเลือกแผ่นงานก่อนครับ');
    return;
  }

  const ss = SpreadsheetApp.openById(sheetId);
  const ocrSheet = ss.getSheetByName('OCR_RESULTS');
  if (!ocrSheet) {
    replyText(event.replyToken, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    return;
  }

  const data = ocrSheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(seq).trim()) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) {
    replyText(event.replyToken, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    return;
  }

  const row = data[rowIndex - 1];
  const status = row[2];        // C: Status
  const remarkCol = row[8];     // I: Remark / error message
  const importStatus = row[9];  // J: ImportStatus

  if (status === 'error') {
    replyText(event.replyToken, `❌ OCR อ่าน SEQ "${seq}" ไม่สำเร็จ: ${remarkCol || 'ไม่ทราบสาเหตุ'}\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ`);
    return;
  }

  if (importStatus === 'imported') {
    replyText(event.replyToken, `ℹ️ SEQ "${seq}" นำเข้าข้อมูลไปแล้วก่อนหน้านี้ครับ`);
    return;
  }

  const summarySheet = ss.getSheetByName('SUMMARY');
  const summaryData = summarySheet.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < summaryData.length; i++) {
    if (String(summaryData[i][0]).trim() === String(seq).trim()) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    replyText(event.replyToken, `❌ ไม่พบหมายเลข SEQ "${seq}" ในแท็บ SUMMARY`);
    return;
  }

  const nationality = row[3] || '';
  const passportNo = row[4] || '';
  const sex = row[5] || '';
  const regexName = row[6] || '';
  const peName = row[7] || '';
  const remark = row[8] || '';

  if (nationality) summarySheet.getRange(targetRow, 4).setValue(nationality);
  if (passportNo) summarySheet.getRange(targetRow, 5).setValue(passportNo);
  if (sex === 'M') {
    summarySheet.getRange(targetRow, 9).setValue(1);
    summarySheet.getRange(targetRow, 10).setValue('');
  } else if (sex === 'F') {
    summarySheet.getRange(targetRow, 9).setValue('');
    summarySheet.getRange(targetRow, 10).setValue(1);
  }

  userProperties.setProperty(userId + '_PASSPORT_NO', passportNo);
  userProperties.setProperty(userId + '_TEMP_ROW', targetRow.toString());
  userProperties.setProperty(userId + '_NAME_REGEX', regexName);
  userProperties.setProperty(userId + '_NAME_PE', peName);

  // Mark ว่า import แล้ว: ขีดฆ่าทั้งแถว + คอลัมน์สุดท้ายใส่ imported
  const fullRowRange = ocrSheet.getRange(rowIndex, 1, 1, ocrSheet.getLastColumn());
  fullRowRange.setFontLine('line-through');
  ocrSheet.getRange(rowIndex, 10).setValue('imported');

  const remarkMsg = remark ? `\n${remark}` : '';
  replyText(event.replyToken, `✅ นำเข้าข้อมูล Passport SEQ [ ${seq} ] เรียบร้อยแล้ว!${remarkMsg}\n\nถ่ายเอกสารอื่นครบแล้วกด "🏁 จบงาน" เพื่อเลือกชื่อ-นามสกุลได้เลยครับ`);
}

function showSummaryAndNameOptions(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const regexName = userProperties.getProperty(userId + '_NAME_REGEX') || 'ไม่สามารถสกัดได้';
  const peName = userProperties.getProperty(userId + '_NAME_PE') || 'ไม่สามารถสกัดได้';

  const flexMessage = {
    "type": "flex",
    "altText": "สรุปข้อมูลและเลือกชื่อ-นามสกุล",
    "contents": {
      "type": "bubble",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          { "type": "text", "text": "📋 สรุปผลการอ่านชื่อ-นามสกุล", "weight": "bold", "size": "md", "color": "#1DB446" },
          { "type": "text", "text": "กรุณาเลือกรูปแบบชื่อที่ถูกต้องเพื่อลงตาราง:", "size": "xs", "color": "#888888", "margin": "xs" },
          { "type": "separator", "margin": "md" },
          {
            "type": "box",
            "layout": "vertical",
            "margin": "md",
            "spacing": "sm",
            "contents": [
              {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                  "type": "postback",
                  "label": `1. Regex: ${regexName.substring(0, 20)}`,
                  "data": `action=confirm_name_selection&choice=REGEX`,
                  "displayText": `เลือกชื่อ: ${regexName}`
                }
              },
              {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                  "type": "postback",
                  "label": `2. PassportEye: ${peName.substring(0, 20)}`,
                  "data": `action=confirm_name_selection&choice=PE`,
                  "displayText": `เลือกชื่อ: ${peName}`
                }
              },
              {
                "type": "button",
                "style": "link",
                "color": "#888888",
                "action": {
                  "type": "postback",
                  "label": "3. ไม่เลือก (เว้นว่างไว้)",
                  "data": `action=confirm_name_selection&choice=NONE`,
                  "displayText": "ไม่เลือกชื่อ (เว้นว่าง)"
                }
              }
            ]
          }
        ]
      }
    }
  };

  sendLineReply(event.replyToken, [flexMessage]);
}

function saveFinalNameAndComplete(event, userId, choice) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const targetRowStr = userProperties.getProperty(userId + '_TEMP_ROW');

  if (sheetId && targetRowStr) {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    const targetRow = parseInt(targetRowStr, 10);

    let finalName = "";
    if (choice === 'REGEX') {
      finalName = userProperties.getProperty(userId + '_NAME_REGEX') || "";
    } else if (choice === 'PE') {
      finalName = userProperties.getProperty(userId + '_NAME_PE') || "";
    }

    if (finalName) {
      summarySheet.getRange(targetRow, 6).setValue(finalName);
    }
  }

  userProperties.deleteProperty(userId + '_TEMP_ROW');
  userProperties.deleteProperty(userId + '_NAME_REGEX');
  userProperties.deleteProperty(userId + '_NAME_PE');

  sendTaskCompletionQuickReply(event.replyToken);
}

function sendTaskCompletionQuickReply(replyToken) {
  const message = {
    "type": "text",
    "text": "✅ บันทึกข้อมูลและจัดเก็บไฟล์เรียบร้อยแล้วครับ!\n----------------------------------\n👇 เลือกรายการที่ต้องการทำต่อได้เลยครับ:",
    "quickReply": {
      "items": [
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "📸 เลือก SEQ",
            "data": "action=menu_select_seq",
            "displayText": "เลือก SEQ เคสถัดไป"
          }
        },
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "📌 จอง SEQ",
            "data": "action=menu_reserve_seq",
            "displayText": "จอง SEQ"
          }
        },
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "🏁 สิ้นสุด",
            "data": "action=menu_end",
            "displayText": "สิ้นสุดการทำงาน"
          }
        }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

// ==========================================
// HELPER & UTILITY FUNCTIONS
// ==========================================
function clearAllUserProperties(userProperties, userId) {
  userProperties.deleteProperty(userId + '_sheetId');
  userProperties.deleteProperty(userId + '_sheetName');
  userProperties.deleteProperty(userId + '_seq');
  userProperties.deleteProperty(userId + '_awaitingSeq');
  userProperties.deleteProperty(userId + '_awaitingBookingCount');
  userProperties.deleteProperty(userId + '_pendingFlightSeqs');
  userProperties.deleteProperty(userId + '_PASSPORT_NO');
  userProperties.deleteProperty(userId + '_TEMP_ROW');
  userProperties.deleteProperty(userId + '_NAME_REGEX');
  userProperties.deleteProperty(userId + '_NAME_PE');
}

function formatFlightNo(rawFlightNo) {
  if (!rawFlightNo) return '';
  return String(rawFlightNo).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function getLineUserProfile(userId) {
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN }
    });
    const profile = JSON.parse(response.getContentText());
    return profile.displayName || 'ผู้ใช้งาน';
  } catch (e) {
    return 'ผู้ใช้งาน';
  }
}

function processBookingInSummarySheet(sheetId, count, userName) {
  const ss = SpreadsheetApp.openById(sheetId);
  const summarySheet = ss.getSheetByName('SUMMARY');
  if (!summarySheet) throw new Error('ไม่พบแท็บ "SUMMARY"');

  const lastRow = summarySheet.getLastRow();
  if (lastRow < 2) throw new Error('ไม่พบข้อมูลแถว SEQ ในแท็บ SUMMARY');

  const range = summarySheet.getRange(2, 1, lastRow - 1, 5);
  const values = range.getValues();
  let bookedSeqs = [];
  let remainingCount = count;
  const todayStr = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
  const bookingText = `จองโดย ${userName}`;

  for (let i = 0; i < values.length; i++) {
    const seq = values[i][0];
    const colEVal = values[i][4];
    if (seq !== '' && (!colEVal || String(colEVal).trim() === '')) {
      const targetRow = i + 2;
      summarySheet.getRange(targetRow, 2).setValue(todayStr);
      summarySheet.getRange(targetRow, 5).setValue(bookingText);
      bookedSeqs.push(seq);
      remainingCount--;
      if (remainingCount === 0) break;
    }
  }
  if (bookedSeqs.length === 0) throw new Error('ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ');
  return bookedSeqs;
}

function updateFlightNoInSummarySheet(sheetId, seqList, flightNo) {
  const ss = SpreadsheetApp.openById(sheetId);
  const summarySheet = ss.getSheetByName('SUMMARY');
  if (!summarySheet) throw new Error('ไม่พบแท็บ "SUMMARY"');

  const data = summarySheet.getDataRange().getValues();
  const seqsToUpdate = Array.isArray(seqList) ? seqList.map(s => String(s).trim()) : [String(seqList).trim()];

  for (let i = 1; i < data.length; i++) {
    const currentSeq = String(data[i][0]).trim();
    if (seqsToUpdate.includes(currentSeq)) {
      summarySheet.getRange(i + 1, 3).setValue(flightNo);
    }
  }
}

function isStopCommand(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return event.message.text.trim().toLowerCase() === 'stop';
  }
  return false;
}

function isResetCommand(event) {
  if (event.type === 'message' && event.message.type === 'sticker') return true;
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const lowerText = text.toLowerCase();
    if (['exit', 'เลือกไฟล์', 'เริ่มต้น', 'start'].includes(lowerText)) return true;
    const emojiRegex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
    if (emojiRegex.test(text) && text.length <= 4) return true;
  }
  return false;
}

function getOrCreatePhotoFolder(mainFolderName, sheetName) {
  const mainFolders = DriveApp.getFoldersByName(mainFolderName);
  let mainFolder = mainFolders.hasNext() ? mainFolders.next() : DriveApp.createFolder(mainFolderName);
  const photoFolders = mainFolder.getFoldersByName('PHOTO');
  let photoFolder = photoFolders.hasNext() ? photoFolders.next() : mainFolder.createFolder('PHOTO');
  const subFolders = photoFolder.getFoldersByName(sheetName);
  return subFolders.hasNext() ? subFolders.next() : photoFolder.createFolder(sheetName);
}

function deleteExistingDriveFile(folder, fileName) {
  const existingFiles = folder.getFilesByName(fileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }
}

function findSeqRowInSheet(sheetId, seq) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  if (!sheet) throw new Error('ไม่พบแท็บ PHOTO');

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(seq).trim()) {
      return i + 1;
    }
  }
  return -1;
}

function saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  const imageFormula = `=IMAGE("${imageUrl}")`;

  if (photoType === 'PASSPORT') sheet.getRange(targetRow, 4).setValue(imageFormula);
  else if (photoType === 'Return Ticket') sheet.getRange(targetRow, 5).setValue(imageFormula);
  else if (photoType === 'Accomodation') sheet.getRange(targetRow, 6).setValue(imageFormula);
  else if (photoType === 'ETC') {
    let targetCol = 7;
    while (sheet.getRange(targetRow, targetCol).getValue() !== '') {
      targetCol++;
    }
    sheet.getRange(targetRow, targetCol).setValue(imageFormula);
  }
}

function findAllSheetsRecursive(folder, pathPrefix) {
  let results = [];
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    const file = files.next();
    results.push({ id: file.getId(), name: file.getName(), path: pathPrefix, updated: file.getLastUpdated().getTime() });
  }
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    const sub = subFolders.next();
    const subPath = pathPrefix ? `${pathPrefix}/${sub.getName()}` : sub.getName();
    results = results.concat(findAllSheetsRecursive(sub, subPath));
  }
  return results;
}

function sendSheetFlexMenu(replyToken) {
  const mainFolders = DriveApp.getFoldersByName(MAIN_FOLDER_NAME);
  if (!mainFolders.hasNext()) {
    replyText(replyToken, `⚠️ ไม่พบโฟลเดอร์ "${MAIN_FOLDER_NAME}" ใน Google Drive`);
    return;
  }
  const mainFolder = mainFolders.next();
  const sheetList = findAllSheetsRecursive(mainFolder, '');
  if (sheetList.length === 0) {
    replyText(replyToken, `⚠️ ไม่พบไฟล์ Google Sheets ในโฟลเดอร์ "${MAIN_FOLDER_NAME}"`);
    return;
  }
  sheetList.sort((a, b) => b.updated - a.updated);
  const top5Sheets = sheetList.slice(0, 5);

  const buttons = top5Sheets.map((file, index) => {
    let labelText = file.path ? `${file.path}/${file.name}` : file.name;
    if (index === 0) labelText = `⭐️ [ล่าสุด] ${labelText}`;
    if (labelText.length > 30) labelText = labelText.substring(0, 27) + '...';
    return {
      type: 'button',
      style: index === 0 ? 'primary' : 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: labelText,
        data: `action=select_sheet&sheetId=${file.id}&sheetName=${encodeURIComponent(file.name)}`,
        displayText: `เลือกแผ่นงาน: ${file.name}`
      }
    };
  });

  const flexMessage = {
    type: 'flex',
    altText: 'เลือกแผ่นงาน Google Sheets',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📊 เลือกแผ่นงาน Google Sheets', weight: 'bold', size: 'md', color: '#1DB446' },
          { type: 'text', text: 'กรุณาเลือกไฟล์ที่ต้องการใช้งาน (แสดง 5 ชีตล่าสุด):', size: 'xs', color: '#888888', margin: 'xs', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: buttons }
        ]
      }
    }
  };
  sendLineReply(replyToken, [flexMessage]);
}

function replySeqPromptWithBookingOption(replyToken, textMessage) {
  const message = {
    type: 'text',
    text: textMessage,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

function replyChangeSeqPrompt(replyToken, textMessage) {
  const message = {
    type: 'text',
    text: textMessage,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '🔢 เปลี่ยน SEQ', data: 'action=menu_select_seq', displayText: 'ขอเปลี่ยน SEQ' } },
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

function getImageBlobFromLine(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  return UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN } }).getBlob();
}

function replyText(replyToken, text) {
  sendLineReply(replyToken, [{ type: 'text', text: text }]);
}

function sendLineReply(replyToken, messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    method: 'post',
    payload: JSON.stringify({ replyToken: replyToken, messages: messages })
  });
}

function parseQueryString(queryString) {
  let query = {};
  let pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
  for (let i = 0; i < pairs.length; i++) {
    let pair = pairs[i].split('=');
    query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
  }
  return query;
}
```

---

## ขั้นตอนการ Deploy

### 1. ฝั่ง Server (Render)
1. วางทับไฟล์ `app.py` และ `requirements.txt` เดิมใน repository ของคุณ (ไฟล์ `Dockerfile` เหมือนเดิม ไม่ต้องแก้)
2. Commit และ push ขึ้น repository
3. Render จะ build และ deploy ให้อัตโนมัติ (หรือกด **Manual Deploy** ใน Render dashboard เพื่อบังคับ deploy ทันที)
4. **สำคัญ — ตั้ง Environment Variables ใหม่ 2 ตัว** ใน Render dashboard (Settings > Environment):
   - `APPS_SCRIPT_WEBHOOK_URL` = URL ของ Apps Script Web App ที่ deploy ไว้ (ลงท้ายด้วย `/exec`)
   - `APPS_SCRIPT_TOKEN` = ค่าเดียวกับ `SECRET_TOKEN` ใน `Code.gs` (ปัจจุบันคือ `hkt12345604`)
   - ถ้าไม่ตั้งค่า `APPS_SCRIPT_WEBHOOK_URL` ระบบจะยัง OCR ได้ปกติแต่ **ผลลัพธ์จะไม่ถูกส่งกลับไปที่ชีตเลย** (จะเห็น log "APPS_SCRIPT_WEBHOOK_URL not configured")
5. **ตั้ง Cron Ping กัน Render หลับ** (แนะนำ ไม่บังคับแต่ช่วยเรื่อง cold start มาก): ใช้ [UptimeRobot](https://uptimerobot.com) หรือ [cron-job.org](https://cron-job.org) (ฟรี) ตั้งให้ยิง `GET` ไปที่ URL หลักของ Render (เช่น `https://passport-ocr-bot1.onrender.com/`) ทุก 10-14 นาที

### 2. ฝั่ง Apps Script (Google Sheets)
1. เปิดโปรเจกต์ Google Apps Script ของคุณ
2. เลือกโค้ดทั้งหมดในไฟล์ `Code.gs` เดิม (Ctrl+A) แล้วลบทิ้ง
3. คัดลอกเฉพาะโค้ดในบล็อก ` ```javascript ` ด้านบน (ตั้งแต่ `// ==========================================` จนถึงปิดท้ายฟังก์ชัน `parseQueryString`) แล้ววางแทนที่
4. บันทึก (Ctrl+S)
5. **สำคัญ:** ไปที่ **Deploy > Manage deployments** → กดไอคอนดินสอ (Edit) ที่ deployment ที่ใช้งานอยู่ → ตรง Version เลือก **New version** → กด **Deploy**
   - ⚠️ การกดบันทึกอย่างเดียวไม่พอ ต้อง Deploy เวอร์ชันใหม่เสมอ ไม่งั้นเว็บแอปจะยังรันโค้ดเวอร์ชันเก่าอยู่
6. **ไม่ต้องสร้างแท็บ `OCR_RESULTS` เอง** — ระบบจะสร้างให้อัตโนมัติในชีตที่กำลังใช้งาน ตอนที่ callback แรกจาก Render เข้ามา

### ⚠️ ข้อควรระวังตอนคัดลอกโค้ด
- **อย่าคัดลอกทั้งไฟล์ Markdown นี้** ไปวางในทั้ง Apps Script และ Server ตรงๆ เพราะไฟล์นี้มีข้อความอธิบายภาษาไทยและเครื่องหมาย ` ``` ` ปนอยู่ ซึ่งไม่ใช่โค้ดที่รันได้
- ให้คัดลอก **เฉพาะเนื้อหาภายในบล็อกโค้ดแต่ละภาษา** (JavaScript ไปไว้ใน `Code.gs`, Python ไปไว้ใน `app.py`) เท่านั้น

### 3. ทดสอบ
- **OCR ชื่อ-นามสกุล:** ถ่ายรูปพาสปอร์ตที่เคยเจอปัญหาชื่อขยะ (`YUBIN KKKKKGGGGG KSKK ZHANG`) ซ้ำอีกครั้ง ควรจะได้ผลลัพธ์ที่ถูกต้อง (`YUBIN ZHANG`)
- **ความเสถียรของการส่งรูป:** ถ่ายพาสปอร์ตติดกันหลายรอบ โดยเฉพาะรอบที่ชื่อไฟล์ยาวไม่เท่ากัน (เช่น SEQ001 vs SEQ012) ควรอ่าน OCR สำเร็จทุกครั้ง ไม่มีอาการหลุดเป็นบางรอบหรือไม่มี log ขึ้นที่ฝั่ง Render
- **ขั้นตอน SEQ หลังกรอก Flight No.:** จอง SEQ กลุ่ม → กรอก Flight No. → พิมพ์หมายเลข SEQ ตามที่ระบบถาม ควรเข้าสู่ขั้นตอนเลือกประเภทรูปภาพได้ปกติ ไม่ขึ้น "ไม่เข้าใจข้อความ"
- **OCR แบบ Background:** ถ่ายรูป Passport → ควรได้ข้อความ "ส่งไปประมวลผลแล้ว" ทันที (ไม่รอ) พร้อมปุ่ม "📥 นำเข้าข้อมูล" → รอสัก 5-10 วิ → เปิดชีตดูแท็บ `OCR_RESULTS` ควรมีแถวใหม่ `Status = done` → กดปุ่ม "นำเข้าข้อมูล" → ควรเห็นข้อมูลถูกเขียนลง `SUMMARY` และแถวใน `OCR_RESULTS` ถูกขีดฆ่า + คอลัมน์ `ImportStatus = imported`
- **กด "นำเข้าข้อมูล" ก่อน OCR เสร็จ:** ควรได้ข้อความแจ้งว่ายังประมวลผลไม่เสร็จ ไม่ error
- **ถ่ายรูป SEQ เดิมซ้ำ:** ควร overwrite แถวเดิมใน `OCR_RESULTS` ไม่สร้างแถวซ้ำ

---

## ประวัติการแก้ไข (Changelog)

| วันที่ | ปัญหา/ฟีเจอร์ | จุดที่แก้ | สรุปการแก้ไข |
|---|---|---|---|
| ครั้งที่ 1 | อ่านชื่อ-นามสกุลผิดพลาด มีคำขยะจาก OCR (`KKKKKGGGGG`, `KSKK`) | `app.py` (`clean_name_field`, `is_noise_token`) + `Code.gs` (`isNoiseToken`) | กรองคำขยะ 2 ชั้น ทั้งฝั่ง Server และ Apps Script |
| ครั้งที่ 2 | ส่งรูปไป OCR Server ล้มเหลวแบบสุ่ม | `Code.gs` (`callExternalPassportOcr`) | เปลี่ยนจากต่อสตริง base64 มาต่อไบต์อาเรย์ (`.concat()`) ตรงๆ แก้ปัญหา padding แทรกกลางไฟล์ภาพ |
| ครั้งที่ 3 | บอทตอบ "ไม่เข้าใจข้อความ" หลังกรอก Flight No. เสร็จ | `Code.gs` (`handleEvent`, ส่วน 4.2) | เพิ่มการตั้งค่า `_awaitingSeq` เป็น `'true'` ก่อนถามหมายเลข SEQ ถัดไป |
| ครั้งที่ 4 | เพิ่มฟีเจอร์เลือกชื่อ Regex vs PassportEye | `app.py` (`parse_mrz_line1_regex`) + `Code.gs` (`showSummaryAndNameOptions`, `confirm_name_selection`) | อ่านชื่อ 2 วิธีคู่ขนาน ให้เจ้าหน้าที่เลือกเองก่อนบันทึกจริง |
| ครั้งที่ 5 | URL ใน `Code.gs` เพี้ยนเป็นรูปแบบ Markdown Link (`[url](url)`) ทำให้บอทตอบกลับไม่ได้เลย | `Code.gs` (5 จุด: `RENDER_OCR_URL`, thumbnail URL, LINE profile/content/reply API) | แก้กลับเป็น URL ปกติทั้งหมด และตัดสินใจไม่กรองคำขยะซ้ำฝั่ง Apps Script แล้ว (ให้ `app.py` กรองชั้นเดียว + คนเลือกเองเป็นด่านสุดท้าย) |
| ครั้งที่ 6 | OCR แบบ synchronous บล็อกการตอบ LINE เวลา Render cold start | `app.py` (`/ocr/submit`, `run_ocr_pipeline`, background thread) + `Code.gs` (`submitPassportOcrAsync`, `handleOcrCallback`, `importOcrResult`, แท็บใหม่ `OCR_RESULTS`) | เปลี่ยนเป็น background processing: ส่งรูปแล้วตอบทันที, OCR เสร็จแล้ว callback มาเก็บไว้ที่ชีต, กดปุ่ม "นำเข้าข้อมูล" ทีหลังเพื่อดึงมาบันทึกจริง |
