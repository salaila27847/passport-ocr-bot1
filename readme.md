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
import time
import requests
from flask import Flask, request, jsonify
from passporteye import read_mrz
from PIL import Image, ImageEnhance, ImageFilter

app = Flask(__name__)

MIN_ACCEPTABLE_SCORE = int(os.environ.get("MIN_ACCEPTABLE_SCORE", "70"))
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

        # ข้อ 4.4: retry + backoff ถ้ายิง callback กลับ Apps Script ไม่สำเร็จ (4 ครั้ง รวมพักเวลา ~14 วิ)
        # ถ้าครบ 4 ครั้งแล้วยังพัง: log ไว้ใน Render log (backup plan อย่างง่ายที่สุด รอการตัดสินใจเพิ่มเติมในอนาคต)
        backoff_seconds = [2, 4, 8]
        max_attempts = 4
        for attempt in range(1, max_attempts + 1):
            try:
                resp = requests.post(
                    f"{APPS_SCRIPT_WEBHOOK_URL}?token={APPS_SCRIPT_TOKEN}",
                    json=callback_payload,
                    timeout=20
                )
                if resp.status_code == 200:
                    break
                print(f"Callback POST attempt {attempt}/{max_attempts} got HTTP {resp.status_code}: {resp.text}")
            except Exception as cb_err:
                print(f"Callback POST attempt {attempt}/{max_attempts} failed: {cb_err}")

            if attempt < max_attempts:
                time.sleep(backoff_seconds[attempt - 1])
            else:
                print(
                    f"CALLBACK PERMANENTLY FAILED after {max_attempts} attempts. "
                    f"seq={seq} sheetId={sheet_id} payload={callback_payload}"
                )

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

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "service": "passport-ocr-bot",
        "version": "1.0",
        "message": "Service is healthy"
    }), 200


@app.route('/ocr', methods=['POST'])
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
const CHANNEL_ACCESS_TOKEN = "PT37Wr/xV+py61KhKIZrCwRLw9fzPPOD0iZ00yFXB3aI6R6iGHJSEu2Pa5MYyfShBq9V5ZwuYEQDAow3XDUdnUfDnNV/ShD+WXC2mCByEXmu7ckWCQPxI53/72NW8EBfk+NdtcyExD9FhCdQB4ekGwdB04t89/1O/w1cDnyilFU=";
const MAIN_FOLDER_NAME = "interview";
const RENDER_OCR_URL = "https://passport-ocr-bot1.onrender.com/ocr";
const RENDER_OCR_SUBMIT_URL = "https://passport-ocr-bot1.onrender.com/ocr/submit";
const SECRET_TOKEN = "hkt12345604";
const IMAGE_BATCH_DEBOUNCE_MS = 5000; // ข้อ 4: หน่วงเวลารวมรูปก่อนตอบกลับครั้งเดียว กันตอบถี่ๆ ทีละรูป (นับจากรูปล่าสุดที่เข้ามาแต่ละรอบ)

// ==========================================
// DEBUG LOGGING (เขียนลง Google Sheet ชื่อ "BOT_DEBUG_LOG" ให้เปิดดูง่ายๆ โดยไม่ต้องเข้า Apps Script Executions)
// ==========================================
function debugLog(message) {
  try {
    Logger.log(message);
    const sheet = getOrCreateDebugLogSheet();
    sheet.appendRow([new Date(), String(message)]);
  } catch (e) {
    Logger.log('debugLog failed: ' + e);
  }
}

function getOrCreateDebugLogSheet() {
  const files = DriveApp.getFilesByName('BOT_DEBUG_LOG');
  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create('BOT_DEBUG_LOG');
  }
  let sheet = ss.getSheetByName('LOG');
  if (!sheet) {
    sheet = ss.insertSheet('LOG');
    sheet.appendRow(['Timestamp', 'Message']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==========================================
// CONCURRENCY (LockService)
// ==========================================
// ครอบ read-modify-write ที่เสี่ยงชนกันเมื่อมีหลายคนใช้งานพร้อมกัน
// พยายามรอ lock 10 วิ ถ้าไม่ได้ retry อีกครั้ง (รอ 5 วิ) ก่อนจะ throw error ให้ผู้ใช้ลองใหม่เอง
function withLock(fn) {
  const lock = LockService.getScriptLock();
  let acquired = lock.tryLock(10000);
  if (!acquired) {
    debugLog('withLock: ไม่ได้ lock ในรอบแรก กำลัง retry...');
    acquired = lock.tryLock(5000);
  }
  if (!acquired) {
    debugLog('withLock: ไม่ได้ lock หลัง retry แล้ว');
    throw new Error('ระบบกำลังประมวลผลรายการอื่นอยู่ กรุณาลองใหม่อีกครั้งครับ');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// BOOKED SEQ TRACKING (ต่อ userName — ใช้โชว์รายการ SEQ ที่จองไว้แต่ยังไม่จบงาน)
// ==========================================
// เก็บแยกจากคอลัมน์ E ของ SUMMARY เพราะคอลัมน์ E ถูก handleSaveSummaryExtra() เขียนทับด้วยเลข Passport
// หลัง OCR สำเร็จ ทำให้ข้อความ "จองโดย {userName}" หายไปก่อนงานจะจบจริง (ก่อนกด "จบ SEQ")
function bookedSeqPropertyKey(sheetId, userName) {
  return `BOOKED_${sheetId}_${userName}`;
}

function getUserBookedSeqs(sheetId, userName) {
  const raw = PropertiesService.getScriptProperties().getProperty(bookedSeqPropertyKey(sheetId, userName));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function addBookedSeqs(sheetId, userName, seqs) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const current = getUserBookedSeqs(sheetId, userName);
  const merged = current.concat(seqs.filter(s => !current.includes(s)));
  scriptProperties.setProperty(bookedSeqPropertyKey(sheetId, userName), JSON.stringify(merged));
}

function removeBookedSeq(sheetId, userName, seq) {
  if (!sheetId || !userName || !seq) return;
  const scriptProperties = PropertiesService.getScriptProperties();
  const remaining = getUserBookedSeqs(sheetId, userName).filter(s => String(s) !== String(seq));
  const key = bookedSeqPropertyKey(sheetId, userName);
  if (remaining.length === 0) {
    scriptProperties.deleteProperty(key);
  } else {
    scriptProperties.setProperty(key, JSON.stringify(remaining));
  }
}

// ข้อความรายการ SEQ ที่ผู้ใช้คนนี้จองไว้แต่ยังไม่จบงาน (คืนสตริงว่างถ้าไม่มี ไม่ต้องแสดงหัวข้อเปล่าๆ)
function formatBookedSeqListText(sheetId, userName) {
  const bookedSeqs = getUserBookedSeqs(sheetId, userName);
  if (bookedSeqs.length === 0) return '';
  return `📋 SEQ ที่คุณจองไว้ (ยังไม่จบงาน): ${bookedSeqs.join(', ')}\n\n`;
}

// ==========================================
// MAIN WEBHOOK (doPost)
// ==========================================
function doPost(e) {
  try {
    debugLog('doPost received. parameter=' + JSON.stringify(e && e.parameter) + ' bodyLength=' + (e && e.postData ? e.postData.contents.length : 'NO_POSTDATA'));

    if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
      debugLog('doPost unauthorized. received token=' + (e && e.parameter && e.parameter.token));
      return ContentService.createTextOutput(JSON.stringify({ status: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const body = JSON.parse(e.postData.contents);
    debugLog('doPost body parsed. action=' + body.action + ' eventsCount=' + (body.events ? body.events.length : 0));

    // Callback จาก app.py หลังประมวลผล OCR แบบ background เสร็จ
    if (body.action === 'ocr_callback') {
      handleOcrCallback(body);
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // คำขอจากหน้า popup ที่เปิดใน in-app browser ของ LINE (ข้อ 5 และ 6) — sheetId/seq/uid/sheetName อยู่ใน
    // query string เดียวกับ URL ของหน้า popup (e.parameter) ส่วนข้อมูลที่กรอกจริงอยู่ใน JSON body
    if (body.action === 'save_photo_classification') {
      return handleSavePhotoClassification(e, body);
    }
    if (body.action === 'defer_photo_classification') {
      return handleDeferPhotoClassification(e);
    }
    if (body.action === 'save_summary_extra') {
      return handleSaveSummaryExtra(e, body);
    }
    if (body.action === 'fetch_ocr_preview') {
      return handleFetchOcrPreview(e);
    }

    const events = body.events || [];
    for (const event of events) {
      try {
        handleEvent(event);
      } catch (eventErr) {
        debugLog('handleEvent Error: ' + eventErr);
        const userId = event.source && event.source.userId;
        if (userId) {
          pushText(userId, `❌ เกิดข้อผิดพลาดขณะประมวลผล: ${eventErr.message}`);
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    debugLog('doPost Error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// POPUP WEB APP (doGet) — ข้อ 5 (จัดการรูปภาพ) และข้อ 6 (ข้อมูลเพิ่มเติม SUMMARY)
// ==========================================
// แทนที่จะใช้ LIFF (ต้องแยก LINE Login channel ต่างหาก ผูกกับ Messaging API channel ไม่ได้แล้ว)
// ใช้วิธีเปิดลิงก์ URL ธรรมดา (action type "uri") ให้ LINE เปิดใน in-app browser ของมันเอง
// หน้าเว็บ (doGet) กับ API ที่หน้าเว็บเรียกกลับมา (doPost) เป็น URL เดียวกัน จึงเป็น same-origin ไม่มีปัญหา CORS
function doGet(e) {
  const page = e.parameter && e.parameter.page;
  if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
    return HtmlService.createHtmlOutput('<p>Unauthorized</p>');
  }
  if (page === 'manage_photos') {
    return renderManagePhotosPage(e);
  }
  if (page === 'extra_info') {
    return renderExtraInfoPage(e);
  }
  return HtmlService.createHtmlOutput('<p>Not found</p>');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

// สร้าง URL ของหน้า popup พร้อม token กันเข้าถึงโดยไม่ได้รับอนุญาต — sheetId/seq/uid อยู่ใน query string
// เพื่อให้หน้าเว็บ POST กลับมาที่ location.href ตรงๆ ได้เลยโดยไม่ต้องแนบซ้ำ (doPost เช็ค token จาก e.parameter อยู่แล้ว)
function buildPopupUrl(page, params) {
  const query = Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] || '')}`)
    .join('&');
  return `${getWebAppUrl()}?page=${encodeURIComponent(page)}&token=${encodeURIComponent(SECRET_TOKEN)}&${query}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CSS ร่วมของหน้า popup ทั้งสองแบบ (ข้อ 5/6) — ดีไซน์เรียบทันสมัย รองรับจอมือถือเป็นหลัก
const POPUP_SHARED_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; color: #1a1a1a; padding-bottom: 96px; }
  header { position: sticky; top: 0; background: #06c755; color: #fff; padding: 14px 16px; font-weight: 700; font-size: 16px; box-shadow: 0 2px 6px rgba(0,0,0,.08); z-index: 10; }
  header small { display: block; font-weight: 400; font-size: 12px; opacity: .9; margin-top: 2px; }
  .container { padding: 12px; max-width: 640px; margin: 0 auto; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 12px; overflow: hidden; }
  .footer-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; padding: 10px 12px; box-shadow: 0 -2px 8px rgba(0,0,0,.1); display: flex; gap: 10px; max-width: 640px; margin: 0 auto; }
  button { border: none; border-radius: 10px; padding: 13px 16px; font-size: 15px; font-weight: 700; flex: 1; cursor: pointer; }
  .btn-primary { background: #06c755; color: #fff; }
  .btn-primary:disabled { background: #b7e6c8; color: #fff; cursor: not-allowed; }
  .btn-secondary { background: #eee; color: #444; }
  .hint { text-align: center; font-size: 12px; color: #888; padding: 8px 12px 0; }
  .warn { display: none; background: #fff3cd; color: #7a5b00; padding: 10px 12px; border-radius: 10px; font-size: 13px; margin: 0 12px 10px; }
  .done-screen { text-align: center; padding: 60px 20px; }
  .done-screen .icon { font-size: 48px; }
  .done-screen p { font-size: 15px; color: #444; line-height: 1.6; }
`;

// ==========================================
// EVENT HANDLER
// ==========================================
function handleEvent(event) {
  const userId = event.source.userId;
  const userProperties = PropertiesService.getUserProperties();
  debugLog(`handleEvent: type=${event.type} messageType=${event.message ? event.message.type : '-'} userId=${userId}`);

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
    const sheetName = userProperties.getProperty(userId + '_sheetName');
    const seq = userProperties.getProperty(userId + '_seq');
    debugLog(`image received. msgId=${event.message.id} sheetId=${sheetId} sheetName=${sheetName} seq=${seq}`);

    if (!sheetId || !seq) {
      debugLog('image rejected: missing sheetId or seq');
      replyText(event.replyToken, '⚠️ กรุณาเลือกแผ่นงาน Google Sheets และกำหนดเลข SEQ ก่อนส่งรูปภาพครับ');
      return;
    }

    let uploaded;
    try {
      uploaded = uploadImageToPendingDrive(event.message.id, seq, sheetName);
      debugLog(`upload success. fileId=${uploaded.fileId} imageUrl=${uploaded.imageUrl}`);
    } catch (err) {
      debugLog('Pending upload error: ' + err + ' stack=' + err.stack);
      replyText(event.replyToken, `❌ อัปโหลดรูปภาพไม่สำเร็จ: ${err.message}`);
      return;
    }

    // เก็บเข้าคิว pending ของ SEQ นี้ ไม่ส่ง Flex ทันที (กันเด้งรัวๆ ตอนส่งหลายรูปพร้อมกัน)
    // เจ้าหน้าที่กดปุ่ม "จัดการรูป" เองเมื่อพร้อมจะจำแนกทีละใบ
    const queue = getPendingQueue(userId, seq);
    queue.push({ fileId: uploaded.fileId, imageUrl: uploaded.imageUrl });
    savePendingQueue(userId, seq, queue);

    // ข้อ 4: LINE ส่งรูปแต่ละใบเป็นคนละ webhook call แยกกัน (แม้ผู้ใช้เลือกส่งพร้อมกันจากคลังภาพ)
    // จึงต้อง debounce ข้าม execution ด้วย CacheService: ทุกรูปที่เข้ามาจะแย่งจอง "ตั๋วล่าสุด" ของ burst นี้
    // แล้ว sleep รอสักครู่ — execution ที่ตั๋วยังไม่ถูกแย่งหลัง sleep เท่านั้นที่จะเป็นคนตอบกลับรวบยอด
    const cache = CacheService.getScriptCache();
    const burstKey = `imgBurst_${userId}_${seq}`;
    const burstCountKey = `imgBurstCount_${userId}_${seq}`;
    const myTicket = `${event.replyToken}|${Date.now()}|${Math.random()}`;
    cache.put(burstKey, myTicket, 30);
    const burstCountSoFar = (parseInt(cache.get(burstCountKey), 10) || 0) + 1;
    cache.put(burstCountKey, String(burstCountSoFar), 30);

    Utilities.sleep(IMAGE_BATCH_DEBOUNCE_MS);

    if (cache.get(burstKey) !== myTicket) {
      // มีรูปใหม่เข้ามาระหว่างรอ ปล่อยให้ execution ของรูปล่าสุดใน burst เป็นคนตอบกลับแทน ไม่ต้องทำอะไรต่อ
      return;
    }

    const finalQueue = getPendingQueue(userId, seq);
    const finalBurstCount = parseInt(cache.get(burstCountKey), 10) || 1;
    cache.remove(burstKey);
    cache.remove(burstCountKey);
    replyBatchAck(event.replyToken, seq, finalBurstCount, finalQueue.length);
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
      const userNameForList = getLineUserProfile(userId);
      const bookedListText = formatBookedSeqListText(data.sheetId, userNameForList);
      replySeqPromptWithBookingOption(
        event.replyToken,
        `📊 คุณเลือกแผ่นงาน: "${data.sheetName}"\n\n${bookedListText}กรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ หรือกดปุ่ม "จอง SEQ" ด้านล่าง:`
      );
      return;
    }

    // เริ่ม/ทำต่อ การจัดการรูปในคิว pending ทั้งหมด (เปิดหน้า popup — ข้อ 5)
    if (data.action === 'manage_photos') {
      handleManagePhotos(event, userId);
      return;
    }

    // ข้อ 14: จบ SEQ นี้ — ไม่ต้องรอผล OCR อีกต่อไป (ชื่อ-นามสกุล/ข้อมูล OCR กรอก/แก้ไขผ่านหน้า "ข้อมูลเพิ่มเติม" แยกอยู่แล้ว)
    if (data.action === 'finish_case') {
      finishSeqCase(event, userId);
      return;
    }

    // Quick Reply Menu Actions หลังจบงาน
    if (data.action === 'menu_select_seq') {
      const sheetIdForSelect = userProperties.getProperty(userId + '_sheetId');
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      const userNameForList = getLineUserProfile(userId);
      const bookedListText = formatBookedSeqListText(sheetIdForSelect, userNameForList);
      replyText(event.replyToken, `${bookedListText}📸 กรุณากรอกเลข SEQ สำหรับเคสถัดไป (เช่น 02 หรือ 105):`);
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

    // ปุ่ม "เพิ่มรูป" ในเมนูรวม (ข้อ 2) — แค่เตือนให้ส่งรูปเข้ามาในแชท ไม่มี action พิเศษ
    if (data.action === 'prompt_add_photo') {
      const seqForPrompt = userProperties.getProperty(userId + '_seq');
      if (!seqForPrompt) {
        replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
        return;
      }
      sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📷 ส่งรูปภาพสำหรับ SEQ ${seqForPrompt} เข้ามาในแชทได้เลยครับ (ส่งได้หลายรูปพร้อมกัน)`,
        quickReply: { items: buildSeqActionQuickReplyItems(seqForPrompt) }
      }]);
      return;
    }

    // ปุ่ม "📝 ข้อมูลเพิ่มเติม" ในเมนูรวม (ข้อ 6) — เปิดหน้า popup กรอกข้อมูลเสริมให้ SUMMARY (รวมส่วนนำเข้า OCR ไว้ด้านบนสุดแล้ว — ข้อ 12)
    // "import_ocr" เก็บไว้เผื่อ quick reply เก่าที่ยังค้างแสดงอยู่ในแชทของผู้ใช้ถูกกด ให้เปิดหน้าเดียวกันนี้แทน
    if (data.action === 'extra_info_form' || data.action === 'import_ocr') {
      sendExtraInfoFormLink(event, userId);
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
        addBookedSeqs(currentSheetId, userName, bookedSeqs);
        userProperties.deleteProperty(userId + '_awaitingBookingCount');
        userProperties.setProperty(userId + '_pendingFlightSeqs', JSON.stringify(bookedSeqs));
        replyText(
          event.replyToken,
          `✅ **รับยอดจอง SEQ เรียบร้อยแล้ว!**\n• ผู้จอง: ${userName}\n• จำนวน: ${count} คน\n• ได้รับ SEQ: ${bookedSeqs.join(', ')}\n\n✈️ กรุณากรอก Flight No. สำหรับการเดินทางกลุ่มนี้:`
        );
      } catch (err) {
        debugLog('Booking Error: ' + err);
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
        const userNameForList = getLineUserProfile(userId);
        const bookedListText = formatBookedSeqListText(currentSheetId, userNameForList);
        replySeqPromptWithBookingOption(
          event.replyToken,
          `🎉 **สรุปการจองสำเร็จ!**\n\n✈️ **Flight No.:** ${formattedFlightNo}\n📋 **รายการ SEQ ที่จอง (${bookedSeqs.length} คน):**\n${seqListStr}\n\n---------------------------\n${bookedListText}กรุณาพิมพ์หมายเลข SEQ ที่ต้องการถ่ายรูปจัดการต่อได้เลยครับ:`
        );
      } catch (err) {
        debugLog('Save Flight Error: ' + err);
        replyText(event.replyToken, `❌ เกิดข้อผิดพลาดในการบันทึก Flight No.: ${err.message}`);
      }
      return;
    }

    // อยู่ในขั้นตอนรอรับหมายเลข SEQ
    const awaitingSeq = userProperties.getProperty(userId + '_awaitingSeq') === 'true';
    if (awaitingSeq) {
      if (!/^\d+$/.test(text) || parseInt(text, 10) <= 0) {
        replyText(event.replyToken, `⚠️ หมายเลข SEQ ต้องเป็นตัวเลขจำนวนเต็มมากกว่า 0 เท่านั้นครับ (เช่น 2 หรือ 105)\nกรุณาพิมพ์หมายเลข SEQ ใหม่อีกครั้ง:`);
        return;
      }
      userProperties.setProperty(userId + '_seq', text);
      userProperties.deleteProperty(userId + '_awaitingSeq');
      sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📸 กำหนด SEQ: [ ${text} ] เรียบร้อยแล้ว\n\nคุณสามารถส่งรูปภาพเข้ามาได้เลย หรือเลือกทำรายการด้านล่าง:`,
        quickReply: { items: buildSeqActionQuickReplyItems(text) }
      }]);
      return;
    }

    replyChangeSeqPrompt(event.replyToken, `❓ ไม่เข้าใจข้อความ "${text}" ครับ\nหากต้องการเปลี่ยนหรือจบ SEQ ปัจจุบัน กดปุ่มด้านล่างได้เลย หรือพิมพ์ "EXIT" เพื่อเลือกแผ่นงานใหม่ / พิมพ์ "STOP" เพื่อหยุดทำงาน`);
  }
}

// ==========================================
// 📸 Image Handling & Classification (ข้อ 5 — popup HTML แทน Flex ทีละใบ)
// ==========================================

// ชื่อไฟล์ที่ใช้แสดงผลสำหรับแต่ละประเภทเอกสาร (photoType ภายในระบบ -> label ชื่อไฟล์)
const PHOTO_TYPE_FILE_LABELS = {
  'PASSPORT': 'PASSPORT',
  'Return Ticket': 'TICKET',
  'Accomodation': 'ACCOMMODATION',
  'ETC': 'ETC'
};

// ตัวเลือกประเภทเอกสารที่โชว์ในหน้า popup จัดการรูป (value ต้องตรงกับคีย์ของ PHOTO_TYPE_FILE_LABELS)
const PHOTO_TYPE_OPTIONS = [
  { value: 'PASSPORT', label: 'PASSPORT' },
  { value: 'Return Ticket', label: 'RETURN TICKET' },
  { value: 'Accomodation', label: 'ACCOMMODATION' },
  { value: 'ETC', label: 'ETC' }
];

// อัปโหลดรูปที่เพิ่งได้รับขึ้น Drive ทันที (ตั้งชื่อชั่วคราว) เพื่อเอา URL มาโชว์พรีวิวในหน้า popup
function uploadImageToPendingDrive(msgId, seq, sheetName) {
  debugLog(`uploadImageToPendingDrive: msgId=${msgId} seq=${seq} sheetName=${sheetName}`);
  const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
  debugLog(`folder resolved: ${folder.getName()} (${folder.getId()})`);
  const imageBlob = getImageBlobFromLine(msgId);
  debugLog(`image blob fetched from LINE. size=${imageBlob.getBytes().length} contentType=${imageBlob.getContentType()}`);
  imageBlob.setName(`${seq}_PENDING_${msgId}.jpg`);

  const file = folder.createFile(imageBlob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;
  debugLog(`drive file created: ${file.getId()} url=${imageUrl}`);

  return { fileId: file.getId(), imageUrl: imageUrl };
}

// ==========================================
// คิวรูป Pending ต่อ SEQ (สำหรับ flow "จัดการรูป" ทีละใบ)
// ==========================================
function getPendingQueue(userId, seq) {
  const raw = PropertiesService.getUserProperties().getProperty(`${userId}_pendingQueue_${seq}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function savePendingQueue(userId, seq, queue) {
  const userProperties = PropertiesService.getUserProperties();
  const key = `${userId}_pendingQueue_${seq}`;
  if (queue.length === 0) {
    userProperties.deleteProperty(key);
  } else {
    userProperties.setProperty(key, JSON.stringify(queue));
  }
}

function removeFromPendingQueue(userId, seq, fileId) {
  const queue = getPendingQueue(userId, seq).filter(item => item.fileId !== fileId);
  savePendingQueue(userId, seq, queue);
  return queue;
}

// ล้างคิว/ตัวนับ pending ของ SEQ หนึ่งๆ ทิ้งทั้งหมด (เรียกตอนกด "จบ SEQ" สำเร็จ - ข้อ 3.7)
function clearPendingQueueState(userId, seq) {
  if (!seq) return;
  const userProperties = PropertiesService.getUserProperties();
  userProperties.deleteProperty(`${userId}_pendingQueue_${seq}`);
  userProperties.deleteProperty(`${userId}_manageTotal_${seq}`);
}

// เมนู quick reply มาตรฐานหลัง SEQ ถูกกำหนด/สลับ (ข้อ 2) — ใช้ซ้ำได้ทุกจุดที่ SEQ พร้อมใช้งาน
function buildSeqActionQuickReplyItems(seq) {
  return [
    { type: 'action', action: { type: 'postback', label: '📷 เพิ่มรูป', data: 'action=prompt_add_photo', displayText: 'เพิ่มรูป' } },
    { type: 'action', action: { type: 'postback', label: '🗂️ จัดการรูปภาพ', data: 'action=manage_photos', displayText: 'จัดการรูปภาพ' } },
    // ข้อ 12: "นำเข้าข้อมูล" ถูกรวมเข้ากับ "ข้อมูลเพิ่มเติม" แล้ว (เป็นส่วนแรกในหน้า popup เดียวกัน) ไม่ต้องมีปุ่มแยกอีกต่อไป
    { type: 'action', action: { type: 'postback', label: '📝 ข้อมูลเพิ่มเติม', data: 'action=extra_info_form', displayText: 'ข้อมูลเพิ่มเติม' } },
    { type: 'action', action: { type: 'postback', label: '🏁 จบ SEQ', data: 'action=finish_case', displayText: 'จบ SEQ' } },
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } }
  ];
}

// ส่งลิงก์เปิดหน้า popup "ข้อมูลเพิ่มเติม" (ข้อ 6) ซึ่งตอนนี้รวมส่วนนำเข้า/แก้ไขข้อมูล OCR ไว้เป็นส่วนแรกด้วยแล้ว (ข้อ 12)
function sendExtraInfoFormLink(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetIdForExtra = userProperties.getProperty(userId + '_sheetId');
  const sheetNameForExtra = userProperties.getProperty(userId + '_sheetName');
  const seqForExtra = userProperties.getProperty(userId + '_seq');
  if (!sheetIdForExtra || !seqForExtra) {
    replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
    return;
  }
  const extraInfoUrl = buildPopupUrl('extra_info', { sheetId: sheetIdForExtra, sheetName: sheetNameForExtra, seq: seqForExtra, uid: userId });
  sendLineReply(event.replyToken, [{
    type: 'template',
    altText: `SEQ ${seqForExtra} — ข้อมูลเพิ่มเติม / นำเข้าข้อมูล OCR`,
    template: {
      type: 'buttons',
      text: `📝 นำเข้าข้อมูล OCR และกรอกข้อมูลเพิ่มเติมสำหรับ SEQ ${seqForExtra}`,
      actions: [
        { type: 'uri', label: '📝 ข้อมูลเพิ่มเติม', uri: extraInfoUrl }
      ]
    },
    quickReply: { items: buildSeqActionQuickReplyItems(seqForExtra) }
  }]);
}

// ข้อความตอบกลับทันทีที่รับรูป (แทนการเด้ง Flex ทันที) พร้อม Quick Reply ให้กดจัดการรูปเมื่อพร้อม
// n = จำนวนรูปที่ส่งเข้ามาในรอบ (burst) นี้, total = จำนวนรูปสะสมทั้งหมดที่รอจัดการของ SEQ นี้ (ข้อ 4)
function replyBatchAck(replyToken, seq, n, total) {
  const message = {
    type: 'text',
    text: `📸 SEQ: ${seq} รับรูปทั้งหมด ${n}/${total} รูปเรียบร้อยแล้ว\n\nต้องการทำอะไรต่อดีครับ?`,
    quickReply: { items: buildSeqActionQuickReplyItems(seq) }
  };
  sendLineReply(replyToken, [message]);
}

// ปุ่ม "🗂️ จัดการรูปภาพ" — ส่งลิงก์เปิดหน้า popup (ข้อ 5) แสดงรูปทั้งหมดในคิว pending ของ SEQ นี้พร้อมกัน
function handleManagePhotos(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const seq = userProperties.getProperty(userId + '_seq');
  if (!seq) {
    replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
    return;
  }

  const queue = getPendingQueue(userId, seq);
  if (queue.length === 0) {
    replyText(event.replyToken, `ℹ️ SEQ ${seq} ไม่มีรูปที่รอจัดการอยู่ในคิวครับ`);
    return;
  }

  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const sheetName = userProperties.getProperty(userId + '_sheetName');
  const url = buildPopupUrl('manage_photos', { sheetId, sheetName, seq, uid: userId });

  sendLineReply(event.replyToken, [{
    type: 'template',
    altText: `SEQ ${seq} มีรูปรอจัดการ ${queue.length} รูป — กดเปิดหน้าจัดการรูปภาพ`,
    template: {
      type: 'buttons',
      text: `🗂️ SEQ ${seq} มีรูปรอจัดการ ${queue.length} รูป`,
      actions: [
        { type: 'uri', label: '🗂️ จัดการรูปภาพ', uri: url }
      ]
    },
    quickReply: { items: buildSeqActionQuickReplyItems(seq) }
  }]);
}

// บันทึกรูป 1 ใบตามประเภทที่เลือก (ย้ายไฟล์ Drive + เขียนแท็บ PHOTO + ส่ง OCR ถ้าเป็น PASSPORT)
// เป็นฟังก์ชัน "บริสุทธิ์" ไม่ผูกกับ LINE event/replyToken เพราะเรียกจากหน้า popup (doPost) ซึ่งไม่มี replyToken ให้ตอบกลับตรงๆ
function classifyAndSavePhoto(sheetId, sheetName, seq, fileId, photoType) {
  try {
    const targetRow = findSeqRowInSheet(sheetId, seq);
    if (targetRow === -1) {
      return { ok: false, photoType, error: `ไม่พบหมายเลข SEQ "${seq}" ในคอลัมน์ A ของแท็บ PHOTO` };
    }

    const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
    const file = DriveApp.getFileById(fileId);
    const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;

    let fileName;
    if (photoType === 'ETC') {
      // ครอบด้วย lock: หาคอลัมน์ว่าง + เขียนสูตรรูปลงชีต ต้องเป็น atomic กันรูป ETC หลายใบชนคอลัมน์กัน (ข้อ 8.3)
      const etcCol = withLock(() => {
        const col = getNextEtcColumn(sheetId, targetRow);
        saveImageUrlToSheetRow(sheetId, targetRow, 'ETC', imageUrl, col);
        return col;
      });
      const etcIndex = etcCol - 6; // col 7 -> ETC_1, col 8 -> ETC_2, ...
      fileName = `${seq}_ETC_${sheetName}_${etcIndex}.jpg`;
      file.setName(fileName);
    } else {
      fileName = `${seq}_${PHOTO_TYPE_FILE_LABELS[photoType]}_${sheetName}.jpg`;
      deleteExistingDriveFile(folder, fileName);
      file.setName(fileName);
      saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl, null);
    }

    let ocrQueued = false;
    let ocrError = '';
    if (photoType === 'PASSPORT') {
      const queued = submitPassportOcrAsync(sheetId, seq, file.getBlob());
      if (queued) {
        recordOcrQueued(sheetId, seq);
        ocrQueued = true;
      } else {
        ocrError = 'บันทึกรูป [Passport] แล้ว แต่ส่งไปประมวลผล OCR ไม่สำเร็จ ลองเปลี่ยน SEQ นี้ใหม่แล้วถ่ายซ้ำได้เลยครับ (ถ่ายซ้ำจะ overwrite ทับไฟล์เดิมเสมอ)';
      }
    }

    return { ok: true, photoType, ocrQueued, ocrError };
  } catch (err) {
    return { ok: false, photoType, error: err.message };
  }
}

// เมนู quick reply มาตรฐานหลังปิดหน้า popup จัดการรูป (ข้อ 5)
function popupFollowUpQuickReplyItems() {
  return [
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🏁 สิ้นสุดแผ่นงาน', data: 'action=menu_end', displayText: 'สิ้นสุดแผ่นงาน' } }
  ];
}

// ข้อ 14 (ข้อย่อย 2.1): เหมือน popupFollowUpQuickReplyItems() แต่แทรก "จบ SEQ" เข้าไปด้วย — ใช้เฉพาะหลังบันทึก
// "ข้อมูลเพิ่มเติม" เพราะขั้นตอนถัดไปที่เป็นไปได้สูงคือกดจบ SEQ นี้เลย (ไม่ใช้ตัวนี้ใน finishSeqCase เอง กันโชว์ปุ่ม
// "จบ SEQ" ซ้ำทันทีหลังจบไปแล้ว)
function extraInfoSavedQuickReplyItems() {
  return [
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🏁 จบ SEQ', data: 'action=finish_case', displayText: 'จบ SEQ' } },
    { type: 'action', action: { type: 'postback', label: '🏁 สิ้นสุดแผ่นงาน', data: 'action=menu_end', displayText: 'สิ้นสุดแผ่นงาน' } }
  ];
}

// เรียกจาก doPost เมื่อหน้า popup กด "เสร็จสิ้น" — บันทึกทุกรูปที่เลือกประเภทแล้วรวดเดียว แล้ว push ข้อความสรุปกลับไป
function handleSavePhotoClassification(e, body) {
  try {
    const sheetId = e.parameter.sheetId;
    const sheetName = e.parameter.sheetName || '';
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    const classifications = (body && body.classifications) || [];

    if (!sheetId || !seq || !uid || classifications.length === 0) {
      return jsonResponse({ success: false, error: 'พารามิเตอร์ไม่ครบ' });
    }

    let savedCount = 0;
    const noteLines = [];
    for (const item of classifications) {
      const result = classifyAndSavePhoto(sheetId, sheetName, seq, item.fileId, item.photoType);
      if (result.ok) {
        removeFromPendingQueue(uid, seq, item.fileId);
        savedCount++;
        if (result.ocrError) noteLines.push(`⚠️ ${result.ocrError}`);
      } else {
        noteLines.push(`❌ [${item.photoType}] ${result.error}`);
      }
    }

    PropertiesService.getUserProperties().deleteProperty(uid + '_manageTotal_' + seq);

    const total = classifications.length;
    const noteText = noteLines.length > 0 ? `\n\n${noteLines.join('\n')}` : '';
    pushMessages(uid, [{
      type: 'text',
      text: `🎉 จัดการรูปภาพเสร็จสิ้น ${savedCount}/${total} รูป${noteText}\n\nกรุณาเลือกสิ่งที่จะทำถัดไป:`,
      quickReply: { items: popupFollowUpQuickReplyItems() }
    }]);

    return jsonResponse({ success: true, savedCount, total });
  } catch (err) {
    debugLog('handleSavePhotoClassification error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
}

// เรียกจาก doPost เมื่อหน้า popup กด "ทำภายหลัง" — ไม่บันทึกอะไร คิวเดิมค้างไว้ครบ แค่แจ้งเตือนแล้วปิด
function handleDeferPhotoClassification(e) {
  try {
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    const remaining = getPendingQueue(uid, seq).length;

    pushMessages(uid, [{
      type: 'text',
      text: `📋 ยังมีรูปค้างจัดการอยู่ ${remaining} รูปสำหรับ SEQ ${seq} ครับ กดปุ่ม "จัดการรูปภาพ" เพื่อจัดการต่อได้ทีหลัง\n\nกรุณาเลือกสิ่งที่จะทำถัดไป:`,
      quickReply: { items: popupFollowUpQuickReplyItems() }
    }]);

    return jsonResponse({ success: true });
  } catch (err) {
    debugLog('handleDeferPhotoClassification error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
}

// เสิร์ฟหน้า popup จัดการรูปภาพ (ข้อ 5) — แสดงรูปทั้งหมดในคิว pending ของ SEQ นี้พร้อมกัน
function renderManagePhotosPage(e) {
  const sheetId = e.parameter.sheetId;
  const sheetName = e.parameter.sheetName || '';
  const seq = e.parameter.seq;
  const uid = e.parameter.uid;
  const queue = getPendingQueue(uid, seq);
  // Apps Script Web App เด้ง (redirect) ไปโหลด HTML จริงจากโดเมน script.googleusercontent.com เสมอ
  // ทำให้ window.location.href ในเบราว์เซอร์ "ไม่ใช่" URL /exec ที่ doPost รับฟังอยู่ — ห้าม fetch กลับไปที่ location.href ตรงๆ
  // ต้องประกอบ URL /exec ที่แท้จริงขึ้นมาเองฝั่งเซิร์ฟเวอร์แล้วฝังเป็นค่าคงที่ลงในหน้า
  const apiUrl = buildPopupUrl('manage_photos', { sheetId, sheetName, seq, uid });

  const rowsHtml = queue.map((item, idx) => {
    const optionsHtml = PHOTO_TYPE_OPTIONS.map(opt => `
      <label class="type-opt">
        <input type="radio" name="type_${idx}" value="${escapeHtml(opt.value)}">
        <span>${escapeHtml(opt.label)}</span>
      </label>`).join('');
    return `
      <div class="card photo-row" data-file-id="${escapeHtml(item.fileId)}">
        <div class="photo-row-inner">
          <img src="${escapeHtml(item.imageUrl)}" alt="รูปที่ ${idx + 1}">
          <div class="type-opts">${optionsHtml}</div>
        </div>
      </div>`;
  }).join('');

  const html = `
    <style>
      ${POPUP_SHARED_STYLE}
      .photo-row-inner { display: flex; gap: 10px; padding: 10px; align-items: stretch; }
      .photo-row-inner img { width: 96px; height: 96px; object-fit: cover; border-radius: 10px; background: #eee; flex-shrink: 0; }
      .type-opts { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-content: center; }
      .type-opt { display: flex; align-items: center; gap: 6px; font-size: 12px; background: #f4f5f7; border-radius: 8px; padding: 8px 6px; }
      .type-opt input { width: 16px; height: 16px; accent-color: #06c755; }
      .photo-row.selected .photo-row-inner { box-shadow: inset 0 0 0 2px #06c755; border-radius: 14px; }
    </style>
    <header>
      🗂️ จัดการรูปภาพ
      <small>SEQ ${escapeHtml(seq)} • ${escapeHtml(sheetName)} • ${queue.length} รูป</small>
    </header>
    <div class="container" id="listView">
      ${rowsHtml || '<p style="text-align:center;color:#888;padding:40px 0;">ไม่มีรูปที่รอจัดการแล้วครับ</p>'}
    </div>
    <div class="warn" id="warn">⚠️ กรุณาเลือกประเภทเอกสารให้ครบทุกรูปก่อนกด "เสร็จสิ้น" ครับ (หรือกด "ทำภายหลัง" ถ้ายังไม่พร้อม)</div>
    <div class="done-screen" id="doneView" style="display:none;"></div>
    <div class="footer-bar" id="footerBar">
      <button class="btn-secondary" id="btnDefer">⏳ ทำภายหลัง</button>
      <button class="btn-primary" id="btnFinish">✅ เสร็จสิ้น</button>
    </div>
    <script>
      var BASE_URL = ${JSON.stringify(apiUrl)};

      document.querySelectorAll('.photo-row input[type=radio]').forEach(function (input) {
        input.addEventListener('change', function () {
          input.closest('.photo-row').classList.add('selected');
        });
      });

      function setBusy(busy) {
        document.getElementById('btnFinish').disabled = busy;
        document.getElementById('btnDefer').disabled = busy;
      }

      function showDone(message) {
        document.getElementById('listView').style.display = 'none';
        document.getElementById('footerBar').style.display = 'none';
        document.getElementById('warn').style.display = 'none';
        var doneView = document.getElementById('doneView');
        doneView.style.display = 'block';
        doneView.innerHTML = '<div class="icon">✅</div><p>' + message + '</p><p style="color:#999;font-size:13px;">กดปุ่มปิด (✕) มุมขวาบนเพื่อกลับไปที่แชทได้เลยครับ</p>';
      }

      function showError(err) {
        setBusy(false);
        alert('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err));
      }

      document.getElementById('btnFinish').addEventListener('click', function () {
        var rows = document.querySelectorAll('.photo-row');
        var classifications = [];
        var allSelected = true;
        rows.forEach(function (row) {
          var checked = row.querySelector('input[type=radio]:checked');
          if (!checked) { allSelected = false; return; }
          classifications.push({ fileId: row.dataset.fileId, photoType: checked.value });
        });
        if (rows.length === 0) { showDone('ไม่มีรูปที่ต้องจัดการแล้วครับ'); return; }
        if (!allSelected) { document.getElementById('warn').style.display = 'block'; return; }

        setBusy(true);
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'save_photo_classification', classifications: classifications })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'บันทึกไม่สำเร็จ');
          showDone('จัดการรูปภาพเสร็จสิ้น ' + res.savedCount + '/' + res.total + ' รูปเรียบร้อยแล้ว');
        }).catch(showError);
      });

      document.getElementById('btnDefer').addEventListener('click', function () {
        setBusy(true);
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'defer_photo_classification' })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'เกิดข้อผิดพลาด');
          showDone('ปิดหน้าจัดการรูปภาพแล้ว รูปที่ยังไม่ได้เลือกประเภทจะค้างในคิวไว้ให้จัดการทีหลังครับ');
        }).catch(showError);
      });
    </script>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('จัดการรูปภาพ — SEQ ' + seq)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
    debugLog("submitPassportOcrAsync Exception: " + err.toString());
    return false;
  }
}

// ข้อความแจ้งว่าส่ง OCR ไปประมวลผลแล้ว (ไม่มี quickReply ในตัวเอง — ปุ่มนำเข้าข้อมูลจะถูกแปะรวมกับข้อความสุดท้ายของชุด reply แทน
// เพราะ LINE แสดง quickReply ของข้อความสุดท้ายเท่านั้นเมื่อส่งหลายข้อความพร้อมกัน)
function buildOcrQueuedMessage(seq) {
  return {
    type: 'text',
    text: `📤 ส่งรูป Passport (SEQ ${seq}) ไปประมวลผล OCR แล้ว\nระบบใช้เวลาสักครู่ กดปุ่ม "นำเข้าข้อมูล" ด้านล่างสุดเมื่อพร้อมดึงผลลัพธ์`
  };
}

// เรียกจาก doPost เมื่อ app.py ประมวลผล OCR เสร็จและยิง callback กลับมา
// เขียนแถว "queued" ลง OCR_RESULTS ทันทีที่ส่งรูป Passport ไป OCR สำเร็จ (ก่อน callback จะมาจริง)
// เพื่อบันทึกเวลาที่ส่งไว้เทียบ timeout 1 นาทีตอนกด "นำเข้าข้อมูล" (ข้อ 4.2)
// ครอบด้วย lock เพราะเขียนแถวเดียวกับที่ handleOcrCallback อาจเขียนพร้อมกันได้ (ข้อ 8.2)
function recordOcrQueued(sheetId, seq) {
  withLock(() => {
    const ocrSheet = getOrCreateOcrResultsSheet(sheetId);
    let rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);
    if (rowIndex === -1) {
      rowIndex = ocrSheet.getLastRow() + 1;
      invalidateSeqRowCache(sheetId, 'OCR_RESULTS');
    }
    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");
    const rowValues = [seq, timestamp, 'queued', '', '', '', '', '', '', 'pending', Date.now()];
    const targetRange = ocrSheet.getRange(rowIndex, 1, 1, 11);
    targetRange.setValues([rowValues]);
    targetRange.setFontLine('none');
  });
}

// ครอบด้วย lock เพราะ Callback จาก Render หลาย SEQ อาจเข้ามาพร้อมกัน เสี่ยงเขียนทับแถวกันเอง (ข้อ 8.2)
function handleOcrCallback(payload) {
  const seq = payload.seq;
  const sheetId = payload.sheetId;
  if (!seq || !sheetId) {
    debugLog('ocr_callback missing seq/sheetId: ' + JSON.stringify(payload));
    return;
  }

  withLock(() => {
    const ocrSheet = getOrCreateOcrResultsSheet(sheetId);
    let rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);
    if (rowIndex === -1) {
      rowIndex = ocrSheet.getLastRow() + 1;
      invalidateSeqRowCache(sheetId, 'OCR_RESULTS');
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
        d.remark || '', 'pending', ''
      ];
    } else {
      rowValues = [
        seq, timestamp, 'error', '', '', '', '', '',
        payload.error || 'OCR failed', 'pending', ''
      ];
    }

    const targetRange = ocrSheet.getRange(rowIndex, 1, 1, 11);
    targetRange.setValues([rowValues]);
    // ล้างขีดฆ่าเดิม เผื่อแถวนี้เคยถูก import ไปแล้วก่อนหน้า (กรณีถ่ายซ้ำ/SEQ ซ้ำ ให้ overwrite ทับ)
    targetRange.setFontLine('none');
  });
}

function getOrCreateOcrResultsSheet(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName('OCR_RESULTS');
  if (!sheet) {
    sheet = ss.insertSheet('OCR_RESULTS');
    const headers = ['SEQ', 'Timestamp', 'Status', 'Nationality', 'PassportNo', 'Sex', 'RegexName', 'PassportEyeName', 'Remark', 'ImportStatus', 'QueuedAtMs'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

// ==========================================
// CACHED SEQ -> ROW INDEX (ข้อ 5.3 — เร่งความเร็วการค้นหาแถวใน SUMMARY/OCR_RESULTS)
// ==========================================
const OCR_TIMEOUT_MS = 60 * 1000; // 1 นาที (ข้อ 4.2)

function buildSeqRowMap(sheetId, tabName) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const seq = String(data[i][0]).trim();
    if (seq) map[seq] = i + 1;
  }
  return map;
}

function findRowBySeqCached(sheetId, tabName, seq) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `rowidx_${sheetId}_${tabName}`;
  let map = null;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { map = JSON.parse(cached); } catch (e) { map = null; }
  }
  if (!map) {
    map = buildSeqRowMap(sheetId, tabName);
    cache.put(cacheKey, JSON.stringify(map), 300); // แคช 5 นาที
  }
  const row = map[String(seq).trim()];
  return row || -1;
}

function invalidateSeqRowCache(sheetId, tabName) {
  CacheService.getScriptCache().remove(`rowidx_${sheetId}_${tabName}`);
}

// เรียกจากปุ่ม "📥 นำเข้าข้อมูล" — ดึงผล OCR จากแท็บ OCR_RESULTS มาบันทึกลง SUMMARY
// อ่านแถว OCR_RESULTS ของ SEQ นี้แบบดิบๆ ไม่แก้ไขอะไร — ใช้ร่วมกันทั้ง handleFetchOcrPreview (ดูตัวอย่างในหน้า popup)
// และ handleSaveSummaryExtra (ตอนกด "บันทึก" จริง เพื่อดึงชื่อ regex/passporteye และมาร์ค imported)
function getOcrResultRowData(sheetId, seq) {
  const ss = SpreadsheetApp.openById(sheetId);
  const ocrSheet = ss.getSheetByName('OCR_RESULTS');
  if (!ocrSheet) return { found: false };
  const rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);
  if (rowIndex === -1) return { found: false };
  const row = ocrSheet.getRange(rowIndex, 1, 1, 11).getValues()[0];
  return {
    found: true,
    rowIndex,
    status: row[2],        // C
    nationality: row[3] || '', // D
    passportNo: row[4] || '',  // E
    sex: row[5] || '',         // F
    regexName: row[6] || '',   // G
    peName: row[7] || '',      // H
    remark: row[8] || '',      // I
    importStatus: row[9] || '', // J
    queuedAtMs: row[10]        // K
  };
}

// เรียกจากปุ่ม "นำเข้าข้อมูล OCR" ในหน้า popup ข้อมูลเพิ่มเติม — คืนค่าดิบให้หน้าเว็บกรอกลงฟอร์มที่แก้ไขได้
// (ไม่เขียนอะไรลงชีตเลย ไม่มาร์ค imported ณ จุดนี้ — จะมาร์คจริงตอนกด "บันทึก" ใน handleSaveSummaryExtra)
function handleFetchOcrPreview(e) {
  try {
    const sheetId = e.parameter.sheetId;
    const seq = e.parameter.seq;
    if (!sheetId || !seq) {
      return jsonResponse({ success: false, message: 'พารามิเตอร์ไม่ครบ' });
    }

    const info = getOcrResultRowData(sheetId, seq);
    if (!info.found) {
      return jsonResponse({ success: false, message: `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่` });
    }

    // ข้อ 4.2: ถ้าส่งไป OCR แล้วเกิน 1 นาทีแต่ callback ยังไม่มา ให้แจ้งว่าอาจ error แทนที่จะบอกให้รอเฉยๆ ตลอดไป
    if (info.status === 'queued') {
      const elapsedMs = info.queuedAtMs ? (Date.now() - Number(info.queuedAtMs)) : 0;
      if (elapsedMs > OCR_TIMEOUT_MS) {
        return jsonResponse({ success: false, message: `⚠️ ประมวลผล OCR สำหรับ SEQ "${seq}" นานเกิน 1 นาทีแล้วแต่ยังไม่ได้ผลลัพธ์ อาจเกิดข้อผิดพลาดระหว่างประมวลผล\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ` });
      }
      return jsonResponse({ success: false, message: `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่` });
    }

    if (info.status === 'error') {
      return jsonResponse({ success: false, message: `❌ OCR อ่าน SEQ "${seq}" ไม่สำเร็จ: ${info.remark || 'ไม่ทราบสาเหตุ'}\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ` });
    }

    return jsonResponse({
      success: true,
      nationality: info.nationality,
      passportNo: info.passportNo,
      sex: info.sex,
      regexName: info.regexName,
      peName: info.peName,
      remark: info.remark // ข้อ 5.2: nationality_mismatch — หน้าเว็บจะ alert() ข้อความนี้ทันทีที่กดนำเข้า
    });
  } catch (err) {
    debugLog('handleFetchOcrPreview error: ' + err);
    return jsonResponse({ success: false, message: err.message });
  }
}

// ข้อ 14: จบ SEQ นี้ — เปลี่ยนจาก "จบงาน" (ที่เดิมรอผล OCR แล้วให้เลือกชื่อ regex/passporteye ก่อนถึงจะจบได้)
// เป็นแค่ปิดเคสตรงๆ ไม่ต้องพึ่ง OCR อีกต่อไป เพราะชื่อ-นามสกุล/ข้อมูล OCR กรอกและแก้ไขผ่านหน้า "ข้อมูลเพิ่มเติม" แยกไปแล้ว (ข้อ 12/14)
function finishSeqCase(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const seq = userProperties.getProperty(userId + '_seq');

  if (!seq) {
    replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
    return;
  }

  // ข้อ 3.7: ล้างคิว/ตัวนับรูป pending ของ SEQ นี้ทิ้ง เพื่อไม่ให้ปนกับ SEQ ใหม่รอบถัดไป
  clearPendingQueueState(userId, seq);

  // ข้อ 1: SEQ นี้จบแล้ว เอาออกจากรายการ "SEQ ที่จองไว้แต่ยังไม่จบงาน" ของผู้ใช้คนนี้
  if (sheetId) {
    const userNameForList = getLineUserProfile(userId);
    removeBookedSeq(sheetId, userNameForList, seq);
  }

  sendLineReply(event.replyToken, [{
    type: 'text',
    text: `🏁 SEQ ${seq} ดำเนินการเสร็จสิ้นแล้ว กรุณาเลือก`,
    quickReply: { items: popupFollowUpQuickReplyItems() }
  }]);
}

// ==========================================
// ข้อมูลเพิ่มเติมให้ SUMMARY (ข้อ 6) — popup form: G/H/K/L/N=dropdown, M=checkbox(DEPORT), O=note
// ==========================================
// อ่านค่า dropdown จากคอลัมน์เดียวในแท็บอ้างอิง (GROUP/VISA/CLAUSE) ตัดค่าว่างและค่าซ้ำออก
function getColumnValuesForDropdown(sheetId, tabName, columnLetter) {
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return [];
    const colIndex = columnLetter.toUpperCase().charCodeAt(0) - 64; // 'A' -> 1, 'M' -> 13
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return [];
    const values = sheet.getRange(1, colIndex, lastRow, 1).getValues().map(row => String(row[0]).trim());
    return [...new Set(values.filter(v => v !== ''))];
  } catch (err) {
    debugLog(`getColumnValuesForDropdown error (${tabName}!${columnLetter}): ${err}`);
    return [];
  }
}

// เสิร์ฟหน้า popup กรอกข้อมูลเพิ่มเติม (ข้อ 6) — pre-fill ด้วยค่าที่มีอยู่แล้วในแถวของ SEQ นี้ถ้ามี
function renderExtraInfoPage(e) {
  const sheetId = e.parameter.sheetId;
  const sheetName = e.parameter.sheetName || '';
  const seq = e.parameter.seq;
  const uid = e.parameter.uid;
  // เหตุผลเดียวกับ renderManagePhotosPage — ต้องประกอบ URL /exec จริงเอง ห้ามใช้ window.location.href
  const apiUrl = buildPopupUrl('extra_info', { sheetId, sheetName, seq, uid });

  const groupOldOptions = getColumnValuesForDropdown(sheetId, 'GROUP', 'A');
  const groupNewOptions = getColumnValuesForDropdown(sheetId, 'GROUP', 'B');
  const visaOptions = getColumnValuesForDropdown(sheetId, 'VISA', 'M');
  const clauseOptions = getColumnValuesForDropdown(sheetId, 'CLAUSE', 'A');

  // ข้อ 12/14: อ่านคอลัมน์ D..O รวดเดียว (D=สัญชาติ, E=เลขพาสปอร์ต, F=ชื่อ-นามสกุล, I/J=เพศ ต่อจากส่วน OCR ที่ย้ายมารวมในหน้านี้)
  let existing = { nationality: '', passportNo: '', name: '', sexM: false, sexF: false, g: '', h: '', k: '', l: '', m: false, n: '', o: '' };
  const targetRow = findRowBySeqCached(sheetId, 'SUMMARY', seq);
  if (targetRow !== -1) {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    const rowValues = summarySheet.getRange(targetRow, 4, 1, 12).getValues()[0]; // คอลัมน์ D..O (4..15)
    existing = {
      nationality: rowValues[0] || '', passportNo: rowValues[1] || '', name: rowValues[2] || '',
      sexM: !!rowValues[5], sexF: !!rowValues[6],
      g: rowValues[3] || '', h: rowValues[4] || '',
      k: rowValues[7] || '', l: rowValues[8] || '',
      m: !!rowValues[9], n: rowValues[10] || '', o: rowValues[11] || ''
    };
  }
  // ข้อ 14: รูป PASSPORT ที่เคยจัดประเภทไว้แล้ว (ถ้ามี) โชว์ใต้ปุ่มนำเข้า OCR ให้เทียบกับค่าที่อ่านได้ก่อนบันทึก
  const passportPhotoUrl = getPassportPhotoUrl(sheetName, seq);

  function buildSelect(id, label, options, selected) {
    const optionsHtml = options.map(opt =>
      `<option value="${escapeHtml(opt)}" ${opt === selected ? 'selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `
      <div class="field">
        <label>${label}</label>
        <select id="${id}">
          <option value="">— ไม่ระบุ —</option>
          ${optionsHtml}
        </select>
      </div>`;
  }

  const html = `
    <style>
      ${POPUP_SHARED_STYLE}
      .field { padding: 12px; border-bottom: 1px solid #f0f0f0; }
      .field:last-child { border-bottom: none; }
      .field label { display: block; font-size: 13px; font-weight: 700; color: #555; margin-bottom: 6px; }
      select, textarea, input[type=text] { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; background: #fafafa; box-sizing: border-box; }
      textarea { resize: vertical; min-height: 70px; font-family: inherit; }
      .checkbox-field { display: flex; align-items: center; gap: 8px; }
      .checkbox-field input { width: 20px; height: 20px; accent-color: #06c755; }
      .sex-row { display: flex; gap: 20px; }
      .section-title { padding: 12px 12px 0; font-size: 13px; font-weight: 700; color: #06c755; }
      .btn-import { margin: 12px; width: calc(100% - 24px); padding: 10px; border-radius: 8px; border: 1px solid #06c755; background: #fff; color: #06c755; font-weight: 700; font-size: 14px; }
      .btn-import:disabled { opacity: 0.6; }
      .ocr-msg { margin: 0 12px 12px; font-size: 12px; color: #e74c3c; display: none; }
      .passport-photo-wrap { margin: 0 12px 12px; text-align: center; }
      .passport-photo-wrap img { max-width: 100%; max-height: 220px; border-radius: 10px; border: 1px solid #eee; }
      .passport-photo-wrap .no-photo { font-size: 12px; color: #999; padding: 20px 0; background: #fafafa; border-radius: 10px; }
      .name-hint { margin: -6px 12px 12px; font-size: 12px; color: #888; display: none; }
    </style>
    <header>
      📝 ข้อมูลเพิ่มเติม
      <small>SEQ ${escapeHtml(seq)} • ${escapeHtml(sheetName)}</small>
    </header>
    <div class="container" id="formView">
      <div class="card">
        <div class="section-title">🛂 ข้อมูลจาก OCR (Passport)</div>
        <button type="button" class="btn-import" id="btnImportOcr">📥 นำเข้าข้อมูล OCR</button>
        <div class="ocr-msg" id="ocrMsg"></div>
        <div class="passport-photo-wrap">
          ${passportPhotoUrl
            ? `<img src="${escapeHtml(passportPhotoUrl)}" alt="รูป Passport SEQ ${escapeHtml(seq)}">`
            : `<div class="no-photo">ยังไม่มีรูป Passport ที่จัดประเภทไว้สำหรับ SEQ นี้</div>`}
        </div>
        <div class="field">
          <label>สัญชาติ (Nationality)</label>
          <input type="text" id="nationality" value="${escapeHtml(existing.nationality)}" placeholder="เช่น THA">
        </div>
        <div class="field">
          <label>เลขที่หนังสือเดินทาง (Passport No.)</label>
          <input type="text" id="passportNo" value="${escapeHtml(existing.passportNo)}" placeholder="เช่น AA1234567">
        </div>
        <div class="field">
          <label>ชื่อ-นามสกุล (Name)</label>
          <input type="text" id="name" value="${escapeHtml(existing.name)}" placeholder="เช่น MISS SOMYING SOMSRI">
        </div>
        <div class="name-hint" id="nameHint"></div>
        <div class="field">
          <label>เพศ (Sex)</label>
          <div class="sex-row">
            <label class="checkbox-field"><input type="checkbox" id="sexM" ${existing.sexM ? 'checked' : ''}><span>ชาย (M)</span></label>
            <label class="checkbox-field"><input type="checkbox" id="sexF" ${existing.sexF ? 'checked' : ''}><span>หญิง (F)</span></label>
          </div>
        </div>
      </div>
      <div class="card">
        ${buildSelect('groupOld', 'กลุ่มเดิม (6 กลุ่ม)', groupOldOptions, existing.g)}
        ${buildSelect('groupNew', 'กลุ่มใหม่ (10 กลุ่ม)', groupNewOptions, existing.h)}
        ${buildSelect('visaNow', 'VISA (NOW)', visaOptions, existing.k)}
        ${buildSelect('visaEx', 'VISA (EX)', visaOptions, existing.l)}
        <div class="field checkbox-field">
          <input type="checkbox" id="deport" ${existing.m ? 'checked' : ''}>
          <label for="deport" style="margin:0;">DEPORT</label>
        </div>
        ${buildSelect('clauses', 'CLAUSES', clauseOptions, existing.n)}
        <div class="field">
          <label>NOTE</label>
          <textarea id="note" placeholder="พิมพ์หมายเหตุ...">${escapeHtml(existing.o)}</textarea>
        </div>
      </div>
    </div>
    <div class="done-screen" id="doneView" style="display:none;"></div>
    <div class="footer-bar" id="footerBar">
      <button class="btn-primary" id="btnSave" style="width:100%;">💾 บันทึก</button>
    </div>
    <script>
      var BASE_URL = ${JSON.stringify(apiUrl)};

      // เพศ M/F เลือกได้ทีละอันเท่านั้น (ทำ checkbox ให้พฤติกรรมเหมือน radio)
      var sexM = document.getElementById('sexM');
      var sexF = document.getElementById('sexF');
      sexM.addEventListener('change', function () { if (sexM.checked) sexF.checked = false; });
      sexF.addEventListener('change', function () { if (sexF.checked) sexM.checked = false; });

      // ปุ่ม "นำเข้าข้อมูล OCR" — ดึงผลอ่าน Passport ล่าสุดมาเติมในฟอร์มที่แก้ไขได้ ไม่บันทึกอะไรจนกว่าจะกด "บันทึก"
      document.getElementById('btnImportOcr').addEventListener('click', function () {
        var btn = this;
        var msgBox = document.getElementById('ocrMsg');
        msgBox.style.display = 'none';
        btn.disabled = true;
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'fetch_ocr_preview' })
        }).then(function (r) { return r.json(); }).then(function (res) {
          btn.disabled = false;
          if (!res.success) {
            msgBox.textContent = res.message || 'ดึงข้อมูล OCR ไม่สำเร็จ';
            msgBox.style.display = 'block';
            return;
          }
          if (res.nationality) document.getElementById('nationality').value = res.nationality;
          if (res.passportNo) document.getElementById('passportNo').value = res.passportNo;
          if (res.sex === 'M') { sexM.checked = true; sexF.checked = false; }
          else if (res.sex === 'F') { sexF.checked = true; sexM.checked = false; }
          // ข้อ 14: เติมชื่อให้อัตโนมัติจาก regex ก่อน (ถ้าไม่มีลอง passporteye) แต่ยังโชว์ทั้งคู่ไว้เทียบ เพราะ OCR อาจอ่านผิดได้ทั้งสองแบบ
          if (res.regexName || res.peName) {
            document.getElementById('name').value = res.regexName || res.peName || document.getElementById('name').value;
            var hint = document.getElementById('nameHint');
            hint.textContent = 'OCR อ่านได้ — Regex: ' + (res.regexName || '-') + ' | PassportEye: ' + (res.peName || '-');
            hint.style.display = 'block';
          }
          // ข้อ 12: สัญชาติผู้ออกเล่ม (issuing country) กับสัญชาติผู้ถือไม่ตรงกัน — เตือนทันทีตอนกดนำเข้า
          if (res.remark) alert('⚠️ ' + res.remark);
        }).catch(function (err) {
          btn.disabled = false;
          msgBox.textContent = 'เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err);
          msgBox.style.display = 'block';
        });
      });

      document.getElementById('btnSave').addEventListener('click', function () {
        var btn = document.getElementById('btnSave');
        btn.disabled = true;
        var payload = {
          action: 'save_summary_extra',
          nationality: document.getElementById('nationality').value,
          passportNo: document.getElementById('passportNo').value,
          name: document.getElementById('name').value,
          sexM: sexM.checked,
          sexF: sexF.checked,
          groupOld: document.getElementById('groupOld').value,
          groupNew: document.getElementById('groupNew').value,
          visaNow: document.getElementById('visaNow').value,
          visaEx: document.getElementById('visaEx').value,
          deport: document.getElementById('deport').checked,
          clauses: document.getElementById('clauses').value,
          note: document.getElementById('note').value
        };
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'บันทึกไม่สำเร็จ');
          document.getElementById('formView').style.display = 'none';
          document.getElementById('footerBar').style.display = 'none';
          var doneView = document.getElementById('doneView');
          doneView.style.display = 'block';
          doneView.innerHTML = '<div class="icon">✅</div><p>บันทึกข้อมูลเพิ่มเติมเรียบร้อยแล้ว</p><p style="color:#999;font-size:13px;">กดปุ่มปิด (✕) มุมขวาบนเพื่อกลับไปที่แชทได้เลยครับ</p>';
        }).catch(function (err) {
          btn.disabled = false;
          alert('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err));
        });
      });
    </script>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('ข้อมูลเพิ่มเติม — SEQ ' + seq)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// เรียกจาก doPost เมื่อหน้า popup ข้อมูลเพิ่มเติมกด "บันทึก"
function handleSaveSummaryExtra(e, body) {
  try {
    const sheetId = e.parameter.sheetId;
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    if (!sheetId || !seq) {
      return jsonResponse({ success: false, error: 'พารามิเตอร์ไม่ครบ' });
    }

    const targetRow = findRowBySeqCached(sheetId, 'SUMMARY', seq);
    if (targetRow === -1) {
      return jsonResponse({ success: false, error: `ไม่พบหมายเลข SEQ "${seq}" ในแท็บ SUMMARY` });
    }

    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    const hasOcrEdits = !!(body.nationality || body.passportNo || body.name || body.sexM || body.sexF);
    withLock(() => {
      if (body.nationality) summarySheet.getRange(targetRow, 4).setValue(body.nationality); // D
      if (body.passportNo) summarySheet.getRange(targetRow, 5).setValue(body.passportNo);   // E
      if (body.name) summarySheet.getRange(targetRow, 6).setValue(body.name);               // F
      if (body.sexM) {
        summarySheet.getRange(targetRow, 9).setValue(1);   // I
        summarySheet.getRange(targetRow, 10).setValue(''); // J
      } else if (body.sexF) {
        summarySheet.getRange(targetRow, 9).setValue('');  // I
        summarySheet.getRange(targetRow, 10).setValue(1);  // J
      }
      summarySheet.getRange(targetRow, 7).setValue(body.groupOld || '');   // G
      summarySheet.getRange(targetRow, 8).setValue(body.groupNew || '');   // H
      summarySheet.getRange(targetRow, 11).setValue(body.visaNow || '');   // K
      summarySheet.getRange(targetRow, 12).setValue(body.visaEx || '');    // L
      summarySheet.getRange(targetRow, 13).setValue(!!body.deport); // M (DEPORT)
      summarySheet.getRange(targetRow, 14).setValue(body.clauses || '');   // N
      summarySheet.getRange(targetRow, 15).setValue(body.note || '');      // O
    });

    // ข้อ 12/14: ถ้ามีการกรอก/แก้ไขข้อมูล OCR ในรอบนี้ (ไม่ว่าจะกดปุ่ม "นำเข้าข้อมูล OCR" หรือพิมพ์เอง)
    // มาร์คแถวใน OCR_RESULTS ว่านำเข้าแล้ว (ขีดฆ่า + ImportStatus) ถ้ามีแถว OCR ที่อ่านเสร็จของ SEQ นี้อยู่ — ไว้ดูสถานะย้อนหลังเฉยๆ
    // (ไม่ต้องผูก userProperties ให้ขั้นตอนเลือกชื่อ regex/passporteye อีกต่อไป เพราะ "จบ SEQ" เลิกพึ่งพา OCR แล้ว — ข้อ 14)
    if (hasOcrEdits) {
      const ocrInfo = getOcrResultRowData(sheetId, seq);
      if (ocrInfo.found && ocrInfo.status === 'done') {
        const ocrSheet = ss.getSheetByName('OCR_RESULTS');
        withLock(() => {
          const fullRowRange = ocrSheet.getRange(ocrInfo.rowIndex, 1, 1, ocrSheet.getLastColumn());
          fullRowRange.setFontLine('line-through');
          ocrSheet.getRange(ocrInfo.rowIndex, 10).setValue('imported');
        });
      }
    }

    if (uid) {
      pushMessages(uid, [{
        type: 'text',
        text: `📝 บันทึกข้อมูลเพิ่มเติมของ SEQ ${seq} เรียบร้อยแล้วครับ\n\nกรุณาเลือกสิ่งที่จะทำถัดไป:`,
        quickReply: { items: extraInfoSavedQuickReplyItems() }
      }]);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    debugLog('handleSaveSummaryExtra error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
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

  // กวาดล้าง key คิว pending/manageTotal ที่ผูกกับ SEQ ต่างๆ ของ user นี้ทิ้งด้วย (ชื่อ key เป็นแบบไดนามิกต่อ SEQ เลย list ตายตัวไม่ได้)
  const prefixQueue = `${userId}_pendingQueue_`;
  const prefixTotal = `${userId}_manageTotal_`;
  const allKeys = userProperties.getKeys();
  for (const key of allKeys) {
    if (key.indexOf(prefixQueue) === 0 || key.indexOf(prefixTotal) === 0) {
      userProperties.deleteProperty(key);
    }
  }
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

// จองแถว SEQ ว่างใน SUMMARY ให้ครบจำนวนที่ขอ ถ้าแถวว่างไม่พอจะ auto-extend แถวใหม่ให้อัตโนมัติ
// (เลข SEQ ของแถวใหม่เกิดจากฟอร์มูลาที่มีอยู่แล้วในชีต ไม่ใช่สคริปต์เป็นคน generate)
// ครอบด้วย LockService เพราะเสี่ยงจองซ้ำกันมากที่สุดถ้ามีหลายคนกดพร้อมกัน
function processBookingInSummarySheet(sheetId, count, userName) {
  return withLock(() => {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    if (!summarySheet) throw new Error('ไม่พบแท็บ "SUMMARY"');

    let lastRow = summarySheet.getLastRow();
    if (lastRow < 2) throw new Error('ไม่พบข้อมูลแถว SEQ ในแท็บ SUMMARY');

    const bookedSeqs = [];
    let remainingCount = count;
    const todayStr = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
    const bookingText = `จองโดย ${userName}`;

    const scanAndBook = (fromRow, toRow) => {
      if (fromRow > toRow || remainingCount <= 0) return;
      const values = summarySheet.getRange(fromRow, 1, toRow - fromRow + 1, 5).getValues();
      for (let i = 0; i < values.length; i++) {
        const seq = values[i][0];
        const colEVal = values[i][4];
        if (seq !== '' && (!colEVal || String(colEVal).trim() === '')) {
          const targetRow = fromRow + i;
          summarySheet.getRange(targetRow, 2).setValue(todayStr);
          summarySheet.getRange(targetRow, 5).setValue(bookingText);
          bookedSeqs.push(seq);
          remainingCount--;
          if (remainingCount === 0) break;
        }
      }
    };

    scanAndBook(2, lastRow);

    if (remainingCount > 0) {
      const extendCount = remainingCount * 2; // เผื่อพอ ถ้าเกินไม่เป็นไร รอบถัดไปใช้ต่อได้
      summarySheet.insertRowsAfter(lastRow, extendCount);
      summarySheet.getRange(lastRow, 1).copyTo(
        summarySheet.getRange(lastRow + 1, 1, extendCount, 1),
        SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
        false
      );
      SpreadsheetApp.flush();
      invalidateSeqRowCache(sheetId, 'SUMMARY'); // แถวใหม่ถูกเพิ่ม ต้องล้างแคช index เดิมทิ้ง (ข้อ 5.3)
      scanAndBook(lastRow + 1, lastRow + extendCount);
    }

    if (bookedSeqs.length === 0) throw new Error('ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ');
    return bookedSeqs;
  });
}

function updateFlightNoInSummarySheet(sheetId, seqList, flightNo) {
  withLock(() => {
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
  });
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

const PENDING_FILE_MAX_AGE_HOURS = 24;

// ลบไฟล์ _PENDING_ ที่ค้างเกิน 24 ชม. ใน Drive (กรณีเจ้าหน้าที่ส่งรูปแล้วไม่กดเลือกประเภทเลย)
// รันโดย time-driven trigger เท่านั้น (ตั้งครั้งเดียวหลัง deploy ด้วย setupCleanupTrigger())
function cleanupPendingFiles() {
  const mainFolders = DriveApp.getFoldersByName(MAIN_FOLDER_NAME);
  if (!mainFolders.hasNext()) return;
  const mainFolder = mainFolders.next();
  const photoFolders = mainFolder.getFoldersByName('PHOTO');
  if (!photoFolders.hasNext()) return;
  const photoFolder = photoFolders.next();

  const cutoffMs = PENDING_FILE_MAX_AGE_HOURS * 60 * 60 * 1000;
  const now = new Date().getTime();
  let deletedCount = 0;

  const subFolders = photoFolder.getFolders();
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    const files = subFolder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (file.getName().indexOf('_PENDING_') === -1) continue;
      const ageMs = now - file.getDateCreated().getTime();
      if (ageMs > cutoffMs) {
        file.setTrashed(true);
        deletedCount++;
      }
    }
  }
  debugLog(`cleanupPendingFiles: ลบไฟล์ PENDING ที่ค้างเกิน ${PENDING_FILE_MAX_AGE_HOURS} ชม. ไปทั้งหมด ${deletedCount} ไฟล์`);
}

// รันฟังก์ชันนี้ "ครั้งเดียว" ด้วยตนเองใน Apps Script Editor (กด Run) หลัง deploy
// เพื่อตั้ง time-driven trigger ให้ cleanupPendingFiles() รันอัตโนมัติทุก 6 ชั่วโมง
function setupCleanupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'cleanupPendingFiles') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('cleanupPendingFiles').timeBased().everyHours(6).create();
}

function getOrCreatePhotoFolder(mainFolderName, sheetName) {
  const mainFolders = DriveApp.getFoldersByName(mainFolderName);
  let mainFolder = mainFolders.hasNext() ? mainFolders.next() : DriveApp.createFolder(mainFolderName);
  const photoFolders = mainFolder.getFoldersByName('PHOTO');
  let photoFolder = photoFolders.hasNext() ? photoFolders.next() : mainFolder.createFolder('PHOTO');
  const subFolders = photoFolder.getFoldersByName(sheetName);
  return subFolders.hasNext() ? subFolders.next() : photoFolder.createFolder(sheetName);
}

// ข้อ 14: หารูป PASSPORT ที่เคยจัดประเภทไว้แล้วของ SEQ นี้ (จากชื่อไฟล์ตามคอนเวนชันของ classifyAndSavePhoto)
// เพื่อโชว์ใต้ปุ่ม "นำเข้าข้อมูล OCR" ในหน้า popup ข้อมูลเพิ่มเติม ให้เทียบรูปกับค่าที่อ่านได้ก่อนบันทึกจริง
function getPassportPhotoUrl(sheetName, seq) {
  try {
    const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
    const fileName = `${seq}_${PHOTO_TYPE_FILE_LABELS['PASSPORT']}_${sheetName}.jpg`;
    const files = folder.getFilesByName(fileName);
    if (!files.hasNext()) return '';
    return `https://drive.google.com/thumbnail?id=${files.next().getId()}&sz=w1000`;
  } catch (err) {
    debugLog('getPassportPhotoUrl error: ' + err);
    return '';
  }
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

// หาคอลัมน์ว่างถัดไปสำหรับรูป ETC ในแถวนี้ (เริ่มที่คอลัมน์ 7 ตามแท็บ PHOTO)
function getNextEtcColumn(sheetId, targetRow) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  let targetCol = 7;
  while (sheet.getRange(targetRow, targetCol).getValue() !== '') {
    targetCol++;
  }
  return targetCol;
}

function saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl, etcCol) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  const imageFormula = `=IMAGE("${imageUrl}")`;

  if (photoType === 'PASSPORT') sheet.getRange(targetRow, 4).setValue(imageFormula);
  else if (photoType === 'Return Ticket') sheet.getRange(targetRow, 5).setValue(imageFormula);
  else if (photoType === 'Accomodation') sheet.getRange(targetRow, 6).setValue(imageFormula);
  else if (photoType === 'ETC') {
    sheet.getRange(targetRow, etcCol).setValue(imageFormula);
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
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    method: 'post',
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    debugLog(`LINE reply API error ${code}: ${response.getContentText()}`);
    throw new Error(`LINE reply failed (${code}): ${response.getContentText()}`);
  }
  debugLog('LINE reply API OK (200)');
}

function pushMessages(userId, messages) {
  try {
    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      method: 'post',
      payload: JSON.stringify({ to: userId, messages: messages }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code !== 200) {
      debugLog(`LINE push API error ${code}: ${response.getContentText()}`);
    }
  } catch (err) {
    debugLog('pushMessages failed: ' + err);
  }
}

function pushText(userId, text) {
  pushMessages(userId, [{ type: 'text', text: text }]);
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
4. **สำคัญ — ตั้ง Environment Variables ใน Render dashboard (Settings > Environment):**
   - `APPS_SCRIPT_WEBHOOK_URL` = URL ของ Apps Script Web App ที่ deploy ไว้ (ลงท้ายด้วย `/exec`)
   - `APPS_SCRIPT_TOKEN` = ค่าเดียวกับ `SECRET_TOKEN` ใน `Code.gs` (ปัจจุบันคือ `hkt12345604`)
   - `MIN_ACCEPTABLE_SCORE` (ไม่บังคับ) = ค่าคะแนนขั้นต่ำที่ยอมรับผลอ่าน MRZ (ค่า default = `70` ถ้าไม่ตั้ง) ปรับได้โดยไม่ต้อง deploy โค้ดใหม่ เผื่อคุณภาพกล้อง/แสงเปลี่ยนบ่อย
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
7. **สำคัญ (ทำครั้งเดียว) — ตั้ง trigger สำหรับล้างไฟล์ค้าง:** ใน Apps Script Editor เลือกฟังก์ชัน `setupCleanupTrigger` ที่มุมบน แล้วกด **Run** ครั้งเดียว (ต้อง authorize สิทธิ์ครั้งแรก) — จะตั้ง time-driven trigger ให้ `cleanupPendingFiles()` รันอัตโนมัติทุก 6 ชั่วโมง เพื่อลบไฟล์ `_PENDING_` ที่ค้างใน Drive เกิน 24 ชม. (กรณีเจ้าหน้าที่ส่งรูปแล้วไม่กดเลือกประเภทเลย)
8. **ไม่ต้องสมัคร LIFF app หรือ channel เพิ่ม (ครั้งที่ 11):** หน้า popup จัดการรูปภาพ/ข้อมูลเพิ่มเติม (ข้อ 5-6) ใช้ `doGet`/`doPost` ของ Web App เดียวกับ webhook นี้เลย เปิดผ่านลิงก์ธรรมดาใน in-app browser ของ LINE ไม่ต้องตั้งค่าอะไรเพิ่มนอกจาก deploy เวอร์ชันใหม่ตามข้อ 5 ด้านบน
9. **ต้องมีแท็บ `GROUP` (คอลัมน์ A = กลุ่มเดิม, คอลัมน์ B = กลุ่มใหม่), `VISA` (คอลัมน์ M) และ `CLAUSE` (คอลัมน์ A) ในชีตที่ใช้งาน** ก่อนเปิดฟอร์ม "📝 ข้อมูลเพิ่มเติม" (ข้อ 6) ไม่งั้น dropdown จะว่างเปล่า (ไม่ error แต่เลือกอะไรไม่ได้)

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
- **รูปแบบชื่อไฟล์ใหม่:** ถ่ายรูป Passport/Ticket/Accommodation ควรได้ชื่อไฟล์ `{SEQ}_{TYPE}_{SHEETNAME}.jpg` (เช่น `12_PASSPORT_testng.jpg`) ส่วน ETC หลายใบใน SEQ เดียวกันควรได้ `{SEQ}_ETC_{SHEETNAME}_1.jpg`, `{SEQ}_ETC_{SHEETNAME}_2.jpg`, ... ใน Drive โดยไม่ทับกัน และลงคอลัมน์ต่างกันในแท็บ `PHOTO`
- **ดู log ผ่าน Google Sheet:** เปิดไฟล์ `BOT_DEBUG_LOG` ที่ระบบสร้างให้อัตโนมัติใน Drive (แท็บ `LOG`) ควรเห็น log ของทุกขั้นตอนเรียงตามเวลา ใช้แทนการเข้า Apps Script Executions ได้เลย
- **อัปโหลดรูปหลายรูปพร้อมกัน (Batch) แบบใหม่ (debounce 2 วิ — ครั้งที่ 10):** ส่งรูปหลายใบ (ทดสอบ 5-6 รูป) เข้าไปรวดเดียว ควรได้ข้อความตอบกลับ **ครั้งเดียว** `SEQ: {seq} รับรูปทั้งหมด n/N รูปเรียบร้อยแล้ว` (n = จำนวนรูปที่ส่งรอบนี้, N = จำนวนรูปสะสมทั้งหมดที่รอจัดการของ SEQ นี้) พร้อมเมนู [📷 เพิ่มรูป][🗂️ จัดการรูปภาพ][📥 นำเข้าข้อมูล][📌 จอง SEQ][🔢 เลือก SEQ] ไม่ใช่ตอบกลับทีละรูปแบบเดิมอีกต่อไป
- **จัดการรูปทีละใบ:** กด "🗂️ จัดการรูปภาพ" ควรเด้ง Flex พร้อม preview รูปแรกในคิว จำแนกเสร็จ 1 รูป ควรเห็นข้อความ progress อัพเดท (`รอจัดการรูป n/N`) ตามด้วย Flex ของรูปถัดไปทันทีในชุด reply เดียวกัน — ระหว่างจัดการรูปทีละใบ **ไม่ควรเห็นปุ่ม "นำเข้าข้อมูล" ปนอยู่** (ครั้งที่ 10) ทำจนครบควรได้ข้อความ "จัดการรูปภาพครบ N/N" พร้อมเมนูรวม 5 ปุ่มด้านบน
- **ค้าง SEQ กลางคัน:** เปลี่ยนไปทำ SEQ อื่นทั้งที่คิวรูปของ SEQ เดิมยังไม่ครบ แล้วย้อนกลับมาเลือก SEQ เดิมอีกครั้ง กด "จัดการรูป" ควรเห็นคิวเดิมที่ค้างไว้ครบ ไม่หายไปไหน
- **Validate SEQ:** พิมพ์ SEQ เป็นตัวอักษรหรือ 0/ติดลบ ควรถูกปฏิเสธและถามซ้ำ ไม่ถูกตั้งเป็น SEQ ทันที
- **จองเกินแถวว่าง:** ลองจอง SEQ จำนวนมากกว่าจำนวนแถวว่างที่เหลือในแท็บ `SUMMARY` ควรเห็นแท็บถูก auto-extend แถวใหม่ให้พอ (เลข SEQ ของแถวใหม่ auto-fill จากฟอร์มูลาเดิมของชีต)
- **Timeout OCR 1 นาที:** ทดสอบ (ยากในทางปฏิบัติ) โดยปิด `APPS_SCRIPT_WEBHOOK_URL` ชั่วคราวแล้วส่งรูป Passport รอเกิน 1 นาทีแล้วกดปุ่ม "นำเข้าข้อมูล" ควรได้ข้อความแจ้งว่าอาจ error ให้ถ่ายใหม่ แทนที่จะบอก "รออีกสักครู่" ตลอดไป
- **คำเตือนสัญชาติไม่ตรง:** ถ่ายพาสปอร์ตที่ issuing country กับ nationality ไม่ตรงกัน กดนำเข้าข้อมูลควรเห็นข้อความคำเตือน ⚠️⚠️ เด่นชัดแยกบรรทัด ไม่ใช่แค่ปนอยู่เงียบๆ ท้ายข้อความ
- **รายการ SEQ ที่จองไว้ (ครั้งที่ 10):** จอง SEQ 2-3 ตัว แต่ยังไม่กด "จบงาน" ตัวไหนเลย → กด "เลือกแผ่นงาน" ใหม่ หรือกด quick reply "🔢 เลือก SEQ" → ควรเห็นข้อความ `📋 SEQ ที่คุณจองไว้ (ยังไม่จบงาน): ...` แสดง SEQ ที่จองไว้ทั้งหมด → ทำ "จบงาน" ของ SEQ หนึ่งจนสำเร็จ → เปิดรายการอีกครั้ง SEQ นั้นควรหายไปจากรายการ
- **เมนูรวมหลังกำหนด SEQ (ครั้งที่ 10):** พิมพ์เลข SEQ ยืนยันเสร็จ ควรเห็น quick reply 5 ปุ่ม [📷 เพิ่มรูป][🗂️ จัดการรูปภาพ][📥 นำเข้าข้อมูล][📌 จอง SEQ][🔢 เลือก SEQ] แนบมาด้วย — กด "📥 นำเข้าข้อมูล" ตอนที่ยังไม่เคยส่งรูป Passport เข้า OCR เลย ควรได้ข้อความแจ้งเตือนพร้อม quick reply ทางลัด [📷 เพิ่มรูป][🔢 เลือก SEQ][📌 จอง SEQ] แทนที่จะ error เฉยๆ

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
| ครั้งที่ 7 | รองรับอัปโหลดรูปหลายรูปพร้อมกัน พร้อมโชว์พรีวิวรูปใต้ปุ่มระบุประเภท | `Code.gs` (`uploadImageToPendingDrive`, `sendImageClassificationMenu`, `handleImageClassification`, `getNextEtcColumn`) | อัปโหลดรูปขึ้น Drive ทันทีที่ได้รับ (ตั้งชื่อชั่วคราว) แล้วใช้ URL มาโชว์เป็น hero image ใน Flex Message; ตอนเลือกประเภท rename ไฟล์เดิมแทนที่จะดาวน์โหลดจาก LINE ซ้ำ; แก้ชื่อไฟล์ ETC ให้แยกลำดับ (`SEQ_ETC_1.jpg`, `SEQ_ETC_2.jpg`, ...) ไม่ให้ทับกัน |
| ครั้งที่ 8 | บอทไม่ตอบกลับเลยเวลาส่งรูป (เงียบสนิท) | `Code.gs` (`sendLineReply`, `buildClassifyButtonsBox`) | สาเหตุจริงคือใช้ `"layout": "grid"` ในปุ่ม 4 ประเภทเอกสาร ซึ่ง LINE Flex Message ไม่รองรับ (รองรับแค่ `vertical`/`horizontal`/`baseline`) ทำให้ LINE API ตอบ 400 ทุกครั้งและ error หลุดไปโดนกลืนเงียบๆ แก้โดยเปลี่ยนเป็น `vertical` ซ้อน `horizontal` (2 แถว 2 ปุ่ม) และเสริมความทนทาน: `sendLineReply` เช็ค response code + throw error ชัดเจน, เพิ่ม `pushMessages`/`pushText` เป็น fallback, เพิ่ม `debugLog` เขียน log ลง Google Sheet ชื่อ `BOT_DEBUG_LOG` ให้ตรวจสอบง่ายโดยไม่ต้องเข้า Apps Script Executions |
| ครั้งที่ 9 | รีวิว requirement ครบ 8 กลุ่ม (จาก `Bot_V3.md`) แก้ 17 รายการที่ยืนยันว่า "ต้องทำ" | `Code.gs` + `app.py` (รายละเอียดด้านล่าง) | ดูรายละเอียดแยกตามข้อในตารางถัดไป |

**รายละเอียดครั้งที่ 9 (แก้พร้อมกัน 17 requirement จากเอกสาร Bot_V3 requirement review):**

| ข้อ | Requirement | จุดที่แก้ |
|---|---|---|
| 2.1 | Auto-extend แถวใหม่ใน `SUMMARY` ให้พอกับจำนวนที่ขอจอง (เลข SEQ auto-fill จากฟอร์มูลาเดิมของชีต ไม่ใช่สคริปต์ generate) | `processBookingInSummarySheet` — `insertRowsAfter` + `copyTo` แบบ `PASTE_FORMULA` เฉพาะคอลัมน์ A |
| 2.2 | Validate SEQ ต้องเป็นจำนวนเต็ม > 0 เท่านั้น ไม่ใช่รับทุกข้อความ | `handleEvent` ส่วน awaitingSeq — เช็ค regex `^\d+$` ก่อนตั้งค่า |
| 3.1 | Cleanup ไฟล์ `_PENDING_` ที่ค้างเกิน 24 ชม. ใน Drive | เพิ่ม `cleanupPendingFiles()` + `setupCleanupTrigger()` (ต้องรัน Run ครั้งเดียวหลัง deploy เพื่อตั้ง time-driven trigger ทุก 6 ชม.) |
| 3.2 | อธิบายเหตุผลตอน fallback เมนูไม่มีรูป preview | ปรับข้อความใน `sendImageClassificationMenuFallback` ให้ชัดว่าเกิดจากการเชื่อมต่อ Drive ขัดข้องชั่วคราว |
| 3.5/3.6 | เปลี่ยน flow รับรูป: ไม่เด้ง Flex ทันที ใช้คิว pending ต่อ SEQ + ปุ่ม "จัดการรูป" หยิบทีละใบพร้อม progress counter | เพิ่มคิว `_pendingQueue_{seq}` (`getPendingQueue`/`savePendingQueue`/`removeFromPendingQueue`), `replyBatchAck`, `handleManagePhotos`, เขียน `handleImageClassification` ใหม่ให้ส่งชุดข้อความ (บันทึกผล + progress + Flex รูปถัดไป) ในการ reply เดียว |
| 3.7 | Reset คิว/ตัวนับ ของ SEQ ตอนกด "จบงาน" สำเร็จ | `clearPendingQueueState` เรียกจาก `saveFinalNameAndComplete`; `clearAllUserProperties` กวาด key ไดนามิกทิ้งด้วยตอน reset/stop |
| 4.1 | ข้อความ error ตอนส่ง OCR ไม่สำเร็จ ให้ระบุชัดว่าถ่ายซ้ำจะ overwrite เสมอ | ปรับข้อความใน `handleImageClassification` กรณี `submitPassportOcrAsync` คืน false |
| 4.2 | Timeout 1 นาที ถ้า callback OCR ไม่มา ให้แจ้ง error แทนที่จะ "รออีกสักครู่" ตลอดไป | เพิ่มคอลัมน์ `QueuedAtMs` ใน `OCR_RESULTS`, `recordOcrQueued()` เขียนแถว `status='queued'` ทันทีตอนส่ง, `importOcrResult` เช็คเวลาผ่านไปเกิน `OCR_TIMEOUT_MS` (60000ms) หรือยัง |
| 4.3 | `MIN_ACCEPTABLE_SCORE` ปรับได้จาก Environment Variable โดยไม่ต้อง deploy ใหม่ | `app.py` เปลี่ยนเป็น `int(os.environ.get("MIN_ACCEPTABLE_SCORE", "70"))` |
| 4.4 | Retry + backoff ตอน Render ยิง callback กลับ Apps Script ล้มเหลว (4 ครั้ง รวม ~14 วิ) | `app.py` (`process_ocr_job_background`) วน retry พร้อม backoff `[2,4,8]` วิ ถ้าครบ 4 ครั้งยังพัง print log ชัดเจน (backup plan อย่างง่ายที่สุด รอตัดสินใจเพิ่มเติม) |
| 5.2 | เน้นคำเตือน `nationality_mismatch` ให้ชัดเจนใน LINE ไม่ใช่แค่ remark เงียบๆ | `importOcrResult` แยกบรรทัดคำเตือน ⚠️⚠️ เด่นชัดเมื่อมี remark |
| 5.3 | ทำ index/cache แทน loop ธรรมดา เร่งความเร็วค้นหาแถวใน `SUMMARY`/`OCR_RESULTS` | เพิ่ม `findRowBySeqCached`/`buildSeqRowMap`/`invalidateSeqRowCache` ใช้ `CacheService` (TTL 5 นาที) แทนการ loop สแกนทั้งชีตทุกครั้ง |
| 8.1–8.4 | ครอบ `processBookingInSummarySheet`, `handleOcrCallback`/`recordOcrQueued`, การหาคอลัมน์+เขียนรูป ETC, `updateFlightNoInSummarySheet` ด้วย LockService กัน race condition | เพิ่ม `withLock()` helper (รอ lock 10 วิ ไม่ได้ retry อีก 5 วิ ก่อน throw error) ครอบทั้ง 4 จุด |
| 3.8 | เปลี่ยนรูปแบบชื่อไฟล์ให้มีชื่อชีตกำกับด้วย กันชนกันเวลาหลายชีตใช้โฟลเดอร์ Drive ร่วมกัน | `handleImageClassification` — PASSPORT/TICKET/ACCOMMODATION ใช้ `{SEQ}_{TYPE}_{SHEETNAME}.jpg`, ETC ใช้ `{SEQ}_ETC_{SHEETNAME}_{N}.jpg` (เดิมไม่มี SHEETNAME) พร้อมแก้ label `Accomodation` ให้สะกดถูกเป็น `ACCOMMODATION` |
| ครั้งที่ 10 | ปรับ UX หลังทดลองใช้จริง: โชว์ SEQ ที่จองค้าง, รวมเมนู quick reply, debounce ตอบรับรูป, เอาปุ่มนำเข้าข้อมูลออกจากข้อความจัดการรูปทีละใบ | `Code.gs` (รายละเอียดด้านล่าง) | ดูรายละเอียดแยกตามข้อในตารางถัดไป |

**รายละเอียดครั้งที่ 10 (ปรับจาก feedback หลังทดลองใช้งานจริง):**

| ข้อ | Requirement | จุดที่แก้ |
|---|---|---|
| 1 | แสดงรายการ SEQ ที่ผู้ใช้คนนี้จองไว้แล้วแต่ยังไม่จบงาน ตอนเลือกแผ่นงาน และตอนจอง SEQ เสร็จ | เพิ่ม section **BOOKED SEQ TRACKING** ใหม่ทั้งหมด: `getUserBookedSeqs`/`addBookedSeqs`/`removeBookedSeq`/`formatBookedSeqListText` เก็บลง `PropertiesService.getScriptProperties()` แยกต่างหาก (คีย์ `BOOKED_{sheetId}_{userName}`) เพราะคอลัมน์ E ของ `SUMMARY` ถูก `importOcrResult()` เขียนทับด้วยเลข Passport หลัง OCR สำเร็จ ทำให้ข้อความ "จองโดย {userName}" หายไปก่อนงานจะจบจริง — เรียก `addBookedSeqs` ใน branch `awaitingBookingCount` หลังจองสำเร็จ, เรียก `removeBookedSeq` ใน `saveFinalNameAndComplete` ตอนกด "จบงาน" สำเร็จ, แสดงผลใน `select_sheet` และ `menu_select_seq` |
| 2 | รวมปุ่มการทำงานเป็นเมนู quick reply เดียว [📷 เพิ่มรูป][🗂️ จัดการรูปภาพ][📥 นำเข้าข้อมูล][📌 จอง SEQ][🔢 เลือก SEQ] ทุกจุดที่ SEQ ถูกกำหนด/สลับ | เพิ่ม `buildSeqActionQuickReplyItems(seq)` ใช้ซ้ำใน: ข้อความยืนยัน SEQ (awaitingSeq), ข้อความ "จัดการรูปภาพครบ N/N", `replyBatchAck`; เพิ่ม postback ใหม่ `action=prompt_add_photo` (ปุ่ม "เพิ่มรูป" — แค่เตือนให้ส่งรูปเข้าแชท ไม่มี action พิเศษ); กด "นำเข้าข้อมูล" ตอนยังไม่มีผล OCR ให้ quick reply ทางลัด [เพิ่มรูป][เลือก SEQ][จอง SEQ] แทน error เฉยๆ ผ่าน `replyNoOcrDataYet()` |
| 3 (แก้ไข) | เอาปุ่ม "นำเข้าข้อมูล" ออกจากข้อความจัดการรูปทีละใบ (เดิมทำให้ดูเหมือนต้องเทียบเคียงกับรูปประเภทอื่นระหว่างจัดการ) | `handleImageClassification` — ลบตัวแปร `includeImportButton` และฟังก์ชัน `importOcrQuickReplyItem` ทิ้ง ปุ่มนำเข้าข้อมูลอยู่ในเมนูรวมของข้อ 2 เท่านั้น (โผล่ตอน SEQ ถูกกำหนด/สลับ หรือตอนจัดการรูปครบคิว ไม่ผูกกับข้อความจัดประเภทรูปทีละใบอีก) — ยืนยันแล้วว่า OCR ส่งเข้าเฉพาะรูป PASSPORT อยู่แล้ว (ไม่ต้องแก้ `app.py`) |
| 4 | ตอบกลับตอนรับรูปครั้งเดียวรวบยอด `รับรูปทั้งหมด n/N` (n=รอบนี้, N=สะสมทั้งหมด) แทนตอบทีละรูป โดยหน่วงเวลาไม่เกิน ~2 วิ | เพิ่ม `IMAGE_BATCH_DEBOUNCE_MS=2000` และ debounce ข้าม execution ด้วย `CacheService.getScriptCache()` ในขั้นตอนรับรูปของ `handleEvent`: แต่ละรูปที่เข้ามาจะเขียน "ตั๋วล่าสุด" ของ burst ลง cache แล้ว `Utilities.sleep(2000)` — execution ที่ตั๋วยังไม่ถูกแย่งหลัง sleep เท่านั้นที่ตอบกลับ (execution อื่นที่มีรูปใหม่มาแทรกระหว่างรอจะเงียบไปเฉยๆ ไม่ตอบซ้ำ) แก้ `replyBatchAck(replyToken, seq, n, total)` ให้รับทั้งจำนวนรอบนี้และยอดสะสม |

⚠️ **ข้อจำกัดของข้อ 4:** Apps Script ไม่มีกลไก delay ข้าม request ที่แม่นยำระดับวินาทีแบบเซิร์ฟเวอร์ปกติ วิธีนี้ใช้ `Utilities.sleep()` ต่อ execution (แต่ละรูปที่ส่งเข้ามาจะมี request ค้างรอ ~2 วิก่อนตอบหรือเงียบ) ซึ่งได้ผลดีในทางปฏิบัติสำหรับ 5-6 รูปต่อ SEQ ตามที่ใช้งานจริง แต่ถ้ามีการส่งรูปถี่มากๆ พร้อมกันจากหลายอุปกรณ์ อาจมีโอกาสน้อยที่ CacheService caches ไม่ sync ทันกันข้าม execution แล้วตอบซ้ำมากกว่า 1 ครั้ง — ยังไม่พบในการทดสอบเบื้องต้น แต่ให้สังเกตไว้เผื่อใช้งานหนักขึ้น

| ครั้งที่ 11 | ข้อ 5-6: popup HTML จัดการรูปภาพ + ฟอร์มข้อมูลเพิ่มเติมให้ SUMMARY (แบบไม่ใช้ LIFF) | `Code.gs` (รายละเอียดด้านล่าง) | ดูรายละเอียดแยกตามข้อในตารางถัดไป |
| ครั้งที่ 12 | บั๊กหลังทดลองใช้จริง: กดปุ่ม "เสร็จสิ้น"/"บันทึก" ในหน้า popup แล้วไม่มีอะไรเกิดขึ้นเลย, หน่วงเวลารับรูปสั้นเกินไป | `Code.gs` (`renderManagePhotosPage`, `renderExtraInfoPage`, `IMAGE_BATCH_DEBOUNCE_MS`) | ดูรายละเอียดด้านล่าง |
| ครั้งที่ 13 | รวม "นำเข้าข้อมูล OCR" เข้ากับหน้า popup "ข้อมูลเพิ่มเติม" ให้แก้ไขค่าที่จะบันทึกได้เอง, เพศเป็น checkbox, alert เตือนสัญชาติไม่ตรงตอนกดนำเข้า, ขึ้น quick reply หลังบันทึก | `Code.gs` (รายละเอียดด้านล่าง) | ดูรายละเอียดด้านล่าง |
| ครั้งที่ 14 | เพิ่มรูป Passport + ช่องชื่อ-นามสกุลในหน้า "ข้อมูลเพิ่มเติม", เพิ่มปุ่ม "จบ SEQ" ในปุ่ม quick reply หลังบันทึก, เปลี่ยน "จบงาน" เป็น "จบ SEQ" ไม่ต้องรอ OCR อีกต่อไป | `Code.gs` (รายละเอียดด้านล่าง) | ดูรายละเอียดด้านล่าง |
| ครั้งที่ 15 | คอลัมน์ M (DEPORT) ในแท็บ `SUMMARY` เดิมบันทึกเป็นเลข `1`/สตริงว่าง `''` แทนค่า checkbox ไม่ใช่ Boolean จริง | `Code.gs` (`handleSaveSummaryExtra`) | เปลี่ยนเป็น `summarySheet.getRange(targetRow, 13).setValue(!!body.deport)` เขียนค่า Boolean `true`/`false` ตรงๆ ตามสถานะ checkbox ที่ติ๊กในหน้า "ข้อมูลเพิ่มเติม" (การอ่านค่ากลับมา pre-fill checkbox ใน `renderExtraInfoPage` ใช้ `!!rowValues[9]` อยู่แล้วซึ่งรองรับทั้งค่าเก่า `1`/`''` และค่าใหม่ `true`/`false` เหมือนกัน ไม่ต้อง migrate ข้อมูลเดิม) |

**รายละเอียดครั้งที่ 11 (ต่อจากครั้งที่ 10 — ข้อ 5-6 ที่ตอนแรกวางแผนไว้ว่าจะใช้ LIFF):**

⚠️ **เหตุผลที่ไม่ใช้ LIFF:** LINE ประกาศตั้งแต่ปี 2019 ว่า **เพิ่ม LIFF app เข้ากับ Messaging API channel โดยตรงไม่ได้แล้ว** ต้องสร้างแยกเป็น LINE Login channel แล้วผูกกับ Messaging API channel แทน ซึ่งเพิ่มความซับซ้อนของการตั้งค่าโดยไม่จำเป็น — ระบบนี้จึงเปลี่ยนไปใช้วิธี **เปิดลิงก์ URL ธรรมดา (`action type: "uri"`) ให้ LINE เปิดใน in-app browser ของมันเอง** แทน ซึ่งทำสิ่งที่ต้องการได้ครบ (แสดงหน้าเว็บ, บันทึกข้อมูลกลับมา, บอทส่งข้อความติดตามผล) โดยไม่ต้องสมัคร channel เพิ่มเลย แลกกับการที่หน้าต่างจะมี toolbar ของ LINE in-app browser (ปุ่มปิด ✕) แทนที่จะเต็มจอไร้ขอบและปิดอัตโนมัติแบบ LIFF จริง

| ข้อ | Requirement | จุดที่แก้ |
|---|---|---|
| 5 | Popup HTML จัดการรูปภาพ แสดงรูปทั้งหมดในคิวพร้อมกัน (รูปซ้าย + เลือกประเภทเอกสารข้างๆ) ปุ่ม "เสร็จสิ้น"/"ทำภายหลัง" | เพิ่ม `doGet(e)` router ใหม่ทั้งหมด (เช็ค `token` เหมือน `doPost`) → `page=manage_photos` เรียก `renderManagePhotosPage(e)` เสิร์ฟหน้า HTML (คิว pending ของ SEQ ทั้งหมดในหน้าเดียว, radio ปลอมเป็น checkbox ต่อรูป, ปุ่ม "เสร็จสิ้น"/"ทำภายหลัง"); ลบ UI แบบ Flex ทีละใบทิ้งทั้งหมด (`buildClassifyButtonsBox`, `buildClassificationFlexMessage`, `sendImageClassificationMenu`, `sendImageClassificationMenuFallback`, `handleImageClassification`, postback `classify_image`) แยก logic การบันทึกรูปออกมาเป็น `classifyAndSavePhoto(sheetId, sheetName, seq, fileId, photoType)` แบบ "บริสุทธิ์" ไม่ผูกกับ LINE event เพื่อให้ทั้ง popup (หลายรูปพร้อมกัน) เรียกซ้ำได้; `handleManagePhotos` เปลี่ยนจากส่ง Flex เป็นส่ง template "buttons" ที่มีปุ่ม `uri` ลิงก์ไปเปิดหน้า popup แทน (คำนวณ URL จาก `buildPopupUrl()`/`getWebAppUrl()`) |
| 5 (ต่อ) | ปุ่ม "เสร็จสิ้น"/"ทำภายหลัง" ต้องบันทึก/ปิดแล้วให้บอทส่งข้อความติดตามผลกลับไปหาผู้ใช้คนเดิม | เพิ่ม `doPost` action ใหม่ 2 อัน: `save_photo_classification` (`handleSavePhotoClassification`) วนบันทึกทุกรูปที่เลือกแล้ว `pushMessages()` สรุปผล + quick reply [จอง SEQ][เลือก SEQ][สิ้นสุดแผ่นงาน] ผ่าน `popupFollowUpQuickReplyItems()`, และ `defer_photo_classification` (`handleDeferPhotoClassification`) ไม่บันทึกอะไรแค่แจ้งเตือนคิวที่ค้างแล้ว push ข้อความชุดเดียวกัน — sheetId/seq/uid ส่งผ่าน query string ของ URL หน้า popup เอง (`e.parameter`) ไม่ต้องส่งซ้ำในตัวหน้าเว็บ เพราะหน้าเว็บ `fetch()` กลับไปที่ `window.location.href` ตรงๆ (same-origin ไม่มีปัญหา CORS, ใช้ header `Content-Type: text/plain` กัน preflight) |
| — | ปุ่ม "🏁 จบงาน / สรุปข้อมูล" เดิมอยู่ในปุ่มท้าย Flex ที่ถูกลบไปข้อ 5 — ถ้าไม่มีที่ไปต่อ SEQ จะจบงานไม่ได้เลย | เพิ่มเข้าไปในเมนูรวม `buildSeqActionQuickReplyItems()` (ข้อ 2) เป็นปุ่ม "🏁 จบงาน" ถาวร ให้กดได้ทุกจุดที่ SEQ ถูกกำหนด/สลับ ไม่ผูกกับ Flex อีกต่อไป |
| 6 | ฟอร์มกรอกข้อมูลเพิ่มให้ `SUMMARY` (G/H/K/L/N=dropdown, M=checkbox DEPORT, O=note) เปิดจากเมนูรวม | เพิ่ม `page=extra_info` ใน `doGet` เรียก `renderExtraInfoPage(e)` — ดึง dropdown ด้วย `getColumnValuesForDropdown(sheetId, tabName, columnLetter)` จากแท็บ `GROUP` (คอลัมน์ A/B), `VISA` (คอลัมน์ M ใช้ทั้ง VISA NOW และ VISA EX), `CLAUSE` (คอลัมน์ A), pre-fill ด้วยค่าที่มีอยู่แล้วในแถว SEQ นั้นถ้ามี; เพิ่มปุ่ม "📝 ข้อมูลเพิ่มเติม" ในเมนูรวม → postback `extra_info_form` ส่งลิงก์แบบเดียวกับข้อ 5; `doPost` action `save_summary_extra` (`handleSaveSummaryExtra`) เขียนคอลัมน์ G,H,K,L,M,N,O ของแถว SEQ ใน `SUMMARY` ครอบด้วย `withLock()` แล้ว push ข้อความยืนยัน |

**ทดสอบข้อ 5-6:**
- ถ่ายรูปหลายใบเข้า SEQ หนึ่ง → กด "🗂️ จัดการรูปภาพ" → ควรได้ปุ่มลิงก์เปิดหน้า popup (ไม่ใช่ Flex ทีละรูปแบบเดิม) → เปิดแล้วควรเห็นรูปทั้งหมดในคิวพร้อมกัน เลือกประเภทให้ครบ กด "เสร็จสิ้น" → หน้าเว็บควรขึ้นข้อความสำเร็จ + กลับไปที่แชทควรเห็นข้อความสรุปพร้อม quick reply [จอง SEQ][เลือก SEQ][สิ้นสุดแผ่นงาน]
- เปิดหน้าจัดการรูปแล้วกด "ทำภายหลัง" โดยไม่เลือกอะไรเลย → คิว pending เดิมต้องยังอยู่ครบ (กด "จัดการรูปภาพ" ใหม่ต้องเห็นรูปเท่าเดิม)
- กด "📝 ข้อมูลเพิ่มเติม" → dropdown ของกลุ่มเดิม/กลุ่มใหม่/VISA/CLAUSES ต้องตรงกับข้อมูลในแท็บ `GROUP`/`VISA`/`CLAUSE` จริง → กรอกแล้วกด "บันทึก" → เปิดชีตดูแท็บ `SUMMARY` คอลัมน์ G,H,K,L,M,N,O ของแถว SEQ นั้นต้องมีค่าตรงกับที่กรอก
- เปิดฟอร์มข้อมูลเพิ่มเติมซ้ำสำหรับ SEQ ที่เคยกรอกไปแล้ว → ค่าที่เคยกรอกไว้ต้อง pre-fill กลับมาให้เห็น ไม่ใช่ฟอร์มเปล่า
- กด "🏁 จบงาน" จากเมนูรวม (ไม่ใช่จากปุ่มใน Flex เพราะไม่มีแล้ว) → ต้องเข้าสู่ขั้นตอนเลือกชื่อ Regex/PassportEye ได้ปกติ

**รายละเอียดครั้งที่ 12 (บั๊กจากการทดลองใช้จริงหลังครั้งที่ 11):**

⚠️ **สาเหตุที่กด "เสร็จสิ้น"/"ทำภายหลัง"/"บันทึก" ในหน้า popup แล้วไม่มีอะไรเกิดขึ้น:** `renderManagePhotosPage`/`renderExtraInfoPage` เดิม fetch กลับไปที่ `window.location.href` ตรงๆ โดยสมมติว่ามันคือ URL `/exec` เดิมที่เปิดมา แต่ Apps Script Web App จริงๆ แล้วจะ **redirect เบราว์เซอร์ไปโหลดเนื้อหาจริงจากโดเมน `script.googleusercontent.com`** เสมอ (เป็นพฤติกรรมมาตรฐานของ `HtmlService`) — ทำให้ `window.location.href` ที่เห็นในเบราว์เซอร์ไม่ใช่ URL `/exec` ที่ `doPost` ฟังอยู่จริง กด fetch ไปจึงไม่ถึง `doPost` เลย (เงียบสนิท ไม่ error ให้เห็นด้วย เพราะ in-app browser ของ LINE มักไม่แสดง `alert()`) แก้โดยประกอบ URL `/exec` ที่แท้จริงขึ้นเองฝั่งเซิร์ฟเวอร์ด้วย `buildPopupUrl()` (มี `token`/`sheetId`/`sheetName`/`seq`/`uid` ครบเหมือนตอนเปิดหน้า) แล้วฝังเป็นค่าคงที่ `BASE_URL` ลงในหน้า HTML แทนที่จะอ่านจาก `window.location.href` — แก้ทั้ง `renderManagePhotosPage` และ `renderExtraInfoPage` (พบว่า `renderExtraInfoPage` เดิมไม่ได้ดึงค่า `uid` จาก `e.parameter` มาเก็บไว้เลยด้วย ทั้งที่ `handleSaveSummaryExtra` ต้องใช้ส่งข้อความยืนยันกลับ จึงเพิ่มเข้าไปพร้อมกัน)

⚠️ **หน่วงเวลารับรูปสั้นเกินไป:** `IMAGE_BATCH_DEBOUNCE_MS` เดิม 2000ms นับจากรูปล่าสุดที่เข้ามาแต่ละรอบ ถ้าผู้ใช้ส่งรูปแต่ละใบห่างกันเกิน 2 วิ (เช่น เลือกรูปทีละใบจากคลังภาพ หรือเน็ตช้า) ตัวจับเวลาจะรีเซ็ตไม่ทัน ทำให้ตอบ "รับรูปทั้งหมด n/N" มากกว่า 1 ครั้งต่อ SEQ เดียว ปรับเพิ่มเป็น **5000ms** — ปรับตัวเลขนี้ได้ตรงๆ ที่ค่าคงที่ต้นไฟล์ถ้ายังไม่พอ (ข้อแลกเปลี่ยน: หน่วงนานขึ้น = ผู้ใช้รอนานขึ้นก่อนเห็นข้อความตอบรับ)

**ทดสอบข้อ 12:**
- เปิดหน้า "จัดการรูปภาพ" เลือกประเภทให้ครบทุกรูป กด "เสร็จสิ้น" → ต้องขึ้นหน้าสำเร็จในหน้า popup เอง และแชท LINE ต้องได้ข้อความสรุปกลับมาจริง (ต้อง deploy เวอร์ชันใหม่ก่อนถึงจะเห็นผล เพราะเป็นการแก้ `Code.gs`)
- เปิดหน้า "ข้อมูลเพิ่มเติม" กรอกแล้วกด "บันทึก" → ต้องขึ้นหน้าสำเร็จ และคอลัมน์ G,H,K,L,M,N,O ในแท็บ `SUMMARY` ต้องถูกเขียนจริง
- ส่งรูปหลายใบห่างกันช้าๆ (3-4 วิ/รูป) → ควรได้รับข้อความ "รับรูปทั้งหมด" แค่ครั้งเดียวสรุปยอดรวม ไม่ตอบถี่ทีละรูป

**รายละเอียดครั้งที่ 13 (feedback หลังทดลองใช้จริงต่อจากครั้งที่ 12):**

⚠️ **เหตุผลที่รวม "นำเข้าข้อมูล" เข้ากับ "ข้อมูลเพิ่มเติม":** ฟังก์ชัน `importOcrResult()` เดิม (ทำงานผ่านปุ่ม quick reply "📥 นำเข้าข้อมูล" แยกต่างหาก) เขียนค่าสัญชาติ/เลขพาสปอร์ต/เพศจาก OCR ลง `SUMMARY` ทันทีแบบไม่ให้แก้ไข ถ้า OCR อ่านผิด (เช่น เลขพาสปอร์ตผิดตัว) ผู้ใช้ไม่มีทางแก้ก่อนบันทึก ต้องไปแก้ในชีตเองทีหลัง — จึงย้าย logic นี้มารวมเป็น **ส่วนแรกสุด** ของหน้า popup "ข้อมูลเพิ่มเติม" (ก่อนดรอปดาวน์กลุ่มเดิม/กลุ่มใหม่) ให้เป็นฟอร์มที่แก้ไขได้ก่อนกด "บันทึก" จริง ลดโอกาสข้อมูลผิดหลุดเข้า `SUMMARY`

| ข้อ | Requirement | จุดที่แก้ |
|---|---|---|
| 12.1 | ย้าย "นำเข้าข้อมูล" มาเป็นส่วนแรกในหน้า popup "ข้อมูลเพิ่มเติม" ก่อนดรอปดาวน์กลุ่มเดิม โดยมีปุ่ม import OCR แยกต่างหาก และผู้ใช้แก้ไขค่าที่จะบันทึกได้เองก่อนกด "บันทึก" | ลบ `importOcrResult()`/`replyNoOcrDataYet()` ทิ้ง (ย้าย logic ไปรวมกับ `handleSaveSummaryExtra`) เพิ่ม `getOcrResultRowData(sheetId, seq)` อ่านแถว `OCR_RESULTS` แบบดิบๆ ใช้ร่วมกัน 2 จุด และ `doPost` action ใหม่ `fetch_ocr_preview` (`handleFetchOcrPreview`) คืนค่าดิบให้หน้าเว็บ **โดยไม่เขียนอะไรลงชีตเลย**; `renderExtraInfoPage` เพิ่มการ์ดแรก "🛂 ข้อมูลจาก OCR (Passport)" มีปุ่ม "📥 นำเข้าข้อมูล OCR" + ช่องกรอกสัญชาติ/เลขพาสปอร์ตที่แก้ไขได้ (pre-fill จากค่าที่เคยบันทึกไว้ใน `SUMMARY` คอลัมน์ D/E ถ้ามี) กดปุ่มแล้ว fetch `fetch_ocr_preview` มาเติมในช่องให้แก้ต่อได้ ไม่ auto-save; ปุ่ม "นำเข้าข้อมูล" แบบ quick reply เดี่ยวๆ (`action=import_ocr`) ถูกลบออกจากเมนูรวม `buildSeqActionQuickReplyItems()` — ถ้ามี quick reply เก่าที่ยังค้างแสดงอยู่ในแชทของผู้ใช้ถูกกด จะ redirect มาเปิดหน้า popup เดียวกันนี้แทนผ่าน `sendExtraInfoFormLink()` (ใช้ร่วมกับปุ่ม "📝 ข้อมูลเพิ่มเติม" ปกติ) |
| 12.2 | ส่วนเพศ แสดงเป็น checkbox แทน (เดิมเลือกอัตโนมัติจากค่า OCR อย่างเดียว) โดยเพศชายกรอกคอลัมน์ I เพศหญิงกรอกคอลัมน์ J | เพิ่ม checkbox คู่ `sexM`/`sexF` ในการ์ด OCR ของ `renderExtraInfoPage` (ทำ JS ให้เลือกได้ทีละอันเหมือน radio) pre-fill จาก `SUMMARY` คอลัมน์ I/J เดิม; `handleSaveSummaryExtra` เขียน I=1,J='' ถ้าติ๊ก `sexM`, หรือ I='',J=1 ถ้าติ๊ก `sexF` |
| 12.3 | ถ้าสัญชาติที่ออกหนังสือกับสัญชาติผู้ถือต่างกัน (nationality mismatch) ให้แจ้งเป็น alert ตอนกดปุ่มนำเข้า | `handleFetchOcrPreview` คืนค่า `remark` (ข้อความ mismatch จาก `app.py`) กลับไปด้วยเสมอถ้ามี ฝั่งหน้าเว็บเรียก `alert('⚠️ ' + res.remark)` ทันทีหลัง fetch สำเร็จตอนกดปุ่ม "นำเข้าข้อมูล OCR" |
| 12.4 | เมื่อบันทึกข้อมูลเพิ่มเติมเรียบร้อย ให้ขึ้น quick reply [จอง SEQ, เลือก SEQ, สิ้นสุด] | `handleSaveSummaryExtra` เปลี่ยนจาก `pushText()` ธรรมดา เป็น `pushMessages()` แนบ `quickReply: { items: popupFollowUpQuickReplyItems() }` (ฟังก์ชันเดียวกับที่ใช้หลังจัดการรูปภาพเสร็จในข้อ 5) |
| — | รักษาขั้นตอนเลือกชื่อ regex/passporteye ตอนกด "🏁 จบงาน" ให้ยังทำงานได้ (เดิมพึ่งพา `userProperties` ที่ `importOcrResult()` เคยตั้งไว้) | `handleSaveSummaryExtra` เมื่อมีการกรอก/แก้ไขข้อมูล OCR ในรอบนั้น (สัญชาติ/เลขพาสปอร์ต/เพศ ไม่ว่างอย่างน้อย 1 อย่าง) และพบแถว `OCR_RESULTS` สถานะ `done` ของ SEQ นี้ จะตั้ง `userProperties` (`_PASSPORT_NO`, `_TEMP_ROW`, `_NAME_REGEX`, `_NAME_PE`) และมาร์คแถว `OCR_RESULTS` เป็น `imported` (ขีดฆ่า) ให้เหมือนพฤติกรรมเดิมทุกประการ |

**ทดสอบข้อ 12.1-12.4:**
- ถ่ายรูป Passport ให้ OCR ประมวลผลเสร็จ (สถานะ `done` ใน `OCR_RESULTS`) → เปิดหน้า "ข้อมูลเพิ่มเติม" → กด "📥 นำเข้าข้อมูล OCR" → ช่องสัญชาติ/เลขพาสปอร์ต และ checkbox เพศ ต้องเติมค่าจาก OCR ให้อัตโนมัติ (ยังไม่บันทึกอะไรลงชีตจนกว่าจะกด "บันทึก")
- แก้เลขพาสปอร์ตในช่องให้ต่างจากที่ OCR อ่านได้ก่อนกด "บันทึก" → เปิดชีตดู `SUMMARY` คอลัมน์ E ต้องเป็นค่าที่แก้ไขแล้ว ไม่ใช่ค่าดิบจาก OCR
- ทดสอบกับ SEQ ที่สัญชาติผู้ออกเล่มกับสัญชาติผู้ถือไม่ตรงกัน (nationality mismatch) → กด "นำเข้าข้อมูล OCR" ต้องเห็น alert เตือนทันที
- กด "บันทึก" แล้วต้องเห็นข้อความยืนยันกลับมาที่แชท พร้อม quick reply [📌 จอง SEQ][🔢 เลือก SEQ][🏁 สิ้นสุดแผ่นงาน]
- กด SEQ ที่ยังไม่มีผล OCR (หรือ OCR ยัง `queued`/`error`) แล้วกด "นำเข้าข้อมูล OCR" ในหน้า popup → ต้องเห็นข้อความแจ้งสถานะ (ไม่ใช่ค้างเงียบ) แต่ยังกรอกช่องสัญชาติ/เลขพาสปอร์ตเองมือแล้วกด "บันทึก" ได้ตามปกติ

⚠️ **หมายเหตุ (แก้ในครั้งที่ 14):** บรรทัดทดสอบเดิมที่นี่เคยบอกให้กด "🏁 จบงาน" แล้วตรวจดูหน้าเลือกชื่อ Regex/PassportEye — พฤติกรรมนั้นถูกแทนที่แล้ว ดูข้อ 14 ด้านล่าง (ปุ่มเปลี่ยนชื่อเป็น "จบ SEQ" และไม่มีหน้าเลือกชื่ออีกต่อไป เพราะย้ายช่องกรอกชื่อไปอยู่ในหน้า "ข้อมูลเพิ่มเติม" แล้ว)

**รายละเอียดครั้งที่ 14 (feedback หลังทดลองใช้จริงต่อจากครั้งที่ 13):**

| ข้อ | Requirement | จุดที่แก้ |
|---|---|---|
| 14.1 | เพิ่มรูป Passport ไว้ใต้ปุ่ม "นำเข้าข้อมูล OCR" ในหน้า "ข้อมูลเพิ่มเติม" | เพิ่ม `getPassportPhotoUrl(sheetName, seq)` หารูปจากชื่อไฟล์ตามคอนเวนชันเดิมของ `classifyAndSavePhoto` (`{seq}_PASSPORT_{sheetName}.jpg`) ในโฟลเดอร์ Drive ของแท็บนั้น คืน URL รูปย่อ (`drive.google.com/thumbnail`) ถ้าไม่พบไฟล์ (ยังไม่เคยจัดประเภทรูป PASSPORT) แสดงข้อความ "ยังไม่มีรูป Passport ที่จัดประเภทไว้" แทน — เรียกใช้ใน `renderExtraInfoPage` แสดงใต้ปุ่มนำเข้า OCR ทันที (ไม่ต้องกดอะไรเพิ่ม) |
| 14.2 | เพิ่มช่องกรอกชื่อ-นามสกุล ในหน้า "ข้อมูลเพิ่มเติม" | เพิ่ม input `name` ในการ์ด OCR ต่อจากช่องเลขพาสปอร์ต pre-fill จาก `SUMMARY` คอลัมน์ F ที่เคยบันทึกไว้ (ถ้ามี); กดปุ่ม "นำเข้าข้อมูล OCR" จะเติมชื่อให้อัตโนมัติจากผลอ่าน Regex ก่อน (ถ้าไม่มีลอง PassportEye) และโชว์ทั้งสองแบบไว้เป็น hint ข้อความเล็กๆ ใต้ช่อง ("OCR อ่านได้ — Regex: ... \| PassportEye: ...") ให้เทียบเผื่อ auto-fill ผิด แก้เองในช่องได้อิสระ; `handleFetchOcrPreview` เพิ่ม `regexName`/`peName` ในผลลัพธ์ที่คืนให้หน้าเว็บ; `handleSaveSummaryExtra` เขียนคอลัมน์ F จากช่องนี้ตอนกด "บันทึก" |
| 14.3 (2.1) | เพิ่มปุ่ม "จบ SEQ" ในปุ่ม quick reply ที่ขึ้นหลังบันทึก "ข้อมูลเพิ่มเติม" (เดิมมีแค่ [จอง SEQ][เลือก SEQ][สิ้นสุดแผ่นงาน]) | เพิ่มฟังก์ชันใหม่ `extraInfoSavedQuickReplyItems()` (แยกจาก `popupFollowUpQuickReplyItems()` เดิม) คืน 4 ปุ่ม [📌 จอง SEQ][🔢 เลือก SEQ][🏁 จบ SEQ][🏁 สิ้นสุดแผ่นงาน] ใช้เฉพาะข้อความยืนยันหลังบันทึกข้อมูลเพิ่มเติมใน `handleSaveSummaryExtra` — จุดอื่นที่ใช้ quick reply แบบ "หลังปิด popup" (บันทึก/เลื่อนจัดการรูปในข้อ 5, และข้อความตอบกลับของ "จบ SEQ" เอง) ยังใช้ `popupFollowUpQuickReplyItems()` เดิม (3 ปุ่ม) เพื่อไม่ให้โชว์ปุ่ม "จบ SEQ" ซ้ำทันทีหลังกดจบไปแล้ว |
| 14.4 | เปลี่ยนเมนู "จบงาน" เป็น "จบ SEQ" — ไม่ต้องรอรับผล OCR อีกต่อไปก่อนจะจบ SEQ ได้ กดแล้วตอบกลับ "SEQ {n} ดำเนินการเสร็จสิ้นแล้ว กรุณาเลือก" พร้อม quick reply [📌 จอง SEQ][🔢 เลือก SEQ][🏁 สิ้นสุดแผ่นงาน] | ลบ `showSummaryAndNameOptions()` (Flex เลือกชื่อ Regex/PassportEye), `saveFinalNameAndComplete()`, `sendTaskCompletionQuickReply()`, และ postback `confirm_name_selection` ทิ้งทั้งหมด — ฟังก์ชันเหล่านี้พึ่งพา `userProperties` (`_TEMP_ROW`/`_NAME_REGEX`/`_NAME_PE`) ที่เดิมตั้งค่าตอน import OCR ซึ่งตอนนี้ไม่จำเป็นแล้วเพราะชื่อกรอก/แก้ไขผ่านหน้า "ข้อมูลเพิ่มเติม" โดยตรง (ข้อ 14.2) แทนที่ด้วยฟังก์ชันใหม่ `finishSeqCase(event, userId)` ทำแค่ล้างคิว pending ของ SEQ (`clearPendingQueueState`) + เอาออกจากรายการ SEQ ที่จองไว้ (`removeBookedSeq`) + ตอบข้อความปิดเคสพร้อม quick reply `popupFollowUpQuickReplyItems()` เปลี่ยน label ปุ่มจาก "🏁 จบงาน" เป็น "🏁 จบ SEQ" ใน `buildSeqActionQuickReplyItems()`; `handleSaveSummaryExtra` เอาส่วนที่เคยตั้ง `userProperties` เหล่านี้ออก เหลือแค่มาร์คแถว `OCR_RESULTS` เป็น `imported` (ขีดฆ่า) ไว้ดูสถานะย้อนหลังเฉยๆ |

**ทดสอบข้อ 14:**
- เปิดหน้า "ข้อมูลเพิ่มเติม" ของ SEQ ที่เคยถ่ายรูป Passport และจัดประเภทไว้แล้ว → ต้องเห็นรูป Passport แสดงอยู่ใต้ปุ่ม "นำเข้าข้อมูล OCR" ทันทีโดยไม่ต้องกดอะไร
- เปิดหน้าเดิมของ SEQ ที่ยังไม่เคยจัดประเภทรูป PASSPORT เลย → ต้องเห็นข้อความ "ยังไม่มีรูป Passport ที่จัดประเภทไว้" แทนที่รูป ไม่ error
- กด "นำเข้าข้อมูล OCR" → ช่องชื่อ-นามสกุลต้องเติมอัตโนมัติ และมีข้อความเล็กๆ โชว์ทั้งชื่อแบบ Regex และ PassportEye ให้เทียบ
- แก้ไขชื่อในช่องเองแล้วกด "บันทึก" → เปิดชีตดู `SUMMARY` คอลัมน์ F ต้องเป็นชื่อที่แก้แล้ว
- กด "บันทึก" ข้อมูลเพิ่มเติม → quick reply ที่ได้ต้องมี 4 ปุ่ม [📌 จอง SEQ][🔢 เลือก SEQ][🏁 จบ SEQ][🏁 สิ้นสุดแผ่นงาน]
- ทดสอบกด "🏁 จบ SEQ" กับ SEQ ที่ **ยังไม่มีผล OCR เลย** (ยังไม่ได้ถ่ายรูป Passport หรือ OCR ยัง queued) → ต้องจบ SEQ ได้ปกติทันที ไม่ค้างรอ ไม่ error
- กด "🏁 จบ SEQ" → ต้องได้ข้อความ "SEQ {n} ดำเนินการเสร็จสิ้นแล้ว กรุณาเลือก" พร้อม quick reply [📌 จอง SEQ][🔢 เลือก SEQ][🏁 สิ้นสุดแผ่นงาน] (3 ปุ่ม ไม่มี "จบ SEQ" ซ้ำ) และ SEQ นั้นต้องหายไปจากรายการ "SEQ ที่จองไว้แต่ยังไม่จบ" เมื่อเลือกแผ่นงาน/จอง SEQ ใหม่
