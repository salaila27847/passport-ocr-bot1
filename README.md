# Passport OCR Bot - คู่มือ Source Code ฉบับสมบูรณ์ (Server + Apps Script)

เอกสารนี้รวบรวม Source Code ทั้ง 2 ฝั่งของระบบ Passport OCR Bot ฉบับล่าสุด ซึ่งแก้ไขปัญหาแล้วทั้งหมด 3 บั๊ก:
1. การอ่านชื่อ-นามสกุลผิดพลาด (มีคำขยะจาก OCR ปนอยู่ เช่น `KKKKKGGGGG`, `KSKK`)
2. การส่งรูปภาพไปยัง OCR Server ล้มเหลวแบบไม่แน่นอน (multipart/form-data เสียหายจาก base64 padding)
3. บอทตอบ "ไม่เข้าใจข้อความ" หลังกรอก Flight No. เสร็จแล้วพิมพ์หมายเลข SEQ ถัดไป

## สารบัญ
1. [สรุปปัญหาและวิธีแก้](#สรุปปัญหาและวิธีแก้)
2. [ฝั่ง Server (Render / Python)](#ฝั่ง-server-render--python)
3. [ฝั่ง Apps Script (Google Sheets / LINE Bot)](#ฝั่ง-apps-script-google-sheets--line-bot)
4. [ขั้นตอนการ Deploy](#ขั้นตอนการ-deploy)
5. [ประวัติการแก้ไข (Changelog)](#ประวัติการแก้ไข-changelog)

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

## ฝั่ง Server (Render / Python)

### `requirements.txt`

```txt
Flask==3.0.0
gunicorn==21.2.0
passporteye==2.2.2
Pillow==10.2.0
```

### `app.py`

```python
import os
import re
import tempfile
from flask import Flask, request, jsonify
from passporteye import read_mrz
from PIL import Image, ImageEnhance, ImageFilter

app = Flask(__name__)

# ค่า valid_score ต่ำสุดที่ยอมรับว่า "อ่านได้ดีพอ" โดยไม่ต้องลองซ้ำด้วยภาพที่ปรับปรุงแล้ว
MIN_ACCEPTABLE_SCORE = 70

# ขนาดภาพสูงสุด (พิกเซล ด้านที่ยาวกว่า) ก่อนส่งเข้า Tesseract
# รูปถ่ายจากมือถือมักมีความละเอียดสูงเกินความจำเป็นสำหรับอ่านแถบ MRZ
# การย่อขนาดก่อนช่วยลดเวลาประมวลผลได้มาก โดยไม่กระทบความแม่นยำ
MAX_DIMENSION = 1800

VOWELS = set("AEIOUY")


def downscale_if_needed(src_path: str, dest_path: str) -> str:
    """ย่อภาพลงถ้าใหญ่เกิน MAX_DIMENSION เพื่อลดเวลาประมวลผลของ Tesseract
    คืนค่า path ของไฟล์ที่จะใช้จริง (ไฟล์เดิมถ้าไม่ต้องย่อ หรือไฟล์ใหม่ถ้าย่อแล้ว)"""
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
    """ตรวจจับคำขยะที่ OCR อ่านมั่วจากรอยเปื้อน/รอยยับในแถบ MRZ
    เช่น KKKKKGGGGG, KSKK — ชื่อคนจริงที่เขียนด้วยอักษรโรมันแทบทั้งหมด
    จะมีสระอย่างน้อย 1 ตัว และไม่มีตัวอักษรเดียวกันซ้ำติดกันยาวๆ"""
    if not word:
        return True
    # กติกาที่ 1: ตัวอักษรเดียวกันซ้ำติดกันตั้งแต่ 3 ตัวขึ้นไป
    if re.search(r"(.)\1{2,}", word):
        return True
    # กติกาที่ 2: ยาว >= 3 ตัวอักษร แต่ไม่มีสระเลย
    if len(word) >= 3 and not any(ch in VOWELS for ch in word):
        return True
    return False


def clean_name_field(raw: str) -> str:
    """ทำความสะอาดฟิลด์ชื่อ (surname / given_names) จาก PassportEye:
    - แปลง < เป็นช่องว่าง, ตัดอักขระที่ไม่ใช่ A-Z ออก
    - ตัดคำที่สั้นเกินไป (< 2 ตัวอักษร) หรือเข้าข่ายคำขยะทิ้ง
    """
    if not raw:
        return ""
    words = re.split(r"[<\s]+", str(raw).upper())
    cleaned = []
    for w in words:
        w = re.sub(r"[^A-Z]", "", w)
        if len(w) >= 2 and not is_noise_token(w):
            cleaned.append(w)
    return " ".join(cleaned)


def enhance_image(src_path: str, dest_path: str) -> None:
    img = Image.open(src_path)
    width, height = img.size
    longest_side = max(width, height)

    # upscale เฉพาะภาพที่เล็กเกินไป (เช่นจากรูปที่ถูกย่อไปแล้วหรือถ่ายมาความละเอียดต่ำ)
    # ถ้าภาพใหญ่พอแล้ว ไม่ต้อง upscale ซ้ำ เพื่อไม่ให้ประมวลผลหนักเกินไปจนเกิด timeout
    if longest_side < 1000:
        img = img.resize((width * 2, height * 2), Image.Resampling.LANCZOS)

    img = ImageEnhance.Contrast(img).enhance(2.0)
    img = ImageEnhance.Sharpness(img).enhance(2.0)
    img.save(dest_path, quality=95)


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
    enhanced_path = None

    try:
        # 1. Save original image
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        # 1.1 ย่อขนาดภาพก่อน ถ้าใหญ่เกินไป (ลดเวลาประมวลผล ป้องกัน worker timeout)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as ds_file:
            ds_candidate = ds_file.name
        ocr_input_path = downscale_if_needed(temp_path, ds_candidate)
        if ocr_input_path == ds_candidate:
            downscaled_path = ds_candidate
        else:
            os.remove(ds_candidate)  # ไม่ได้ใช้ ลบทิ้ง

        # 2. First OCR attempt
        mrz = read_mrz(ocr_input_path)
        best_score = getattr(mrz, "valid_score", 0) if mrz is not None else -1

        # 3. ลองอ่านซ้ำด้วยภาพที่ปรับปรุงแล้ว ถ้าอ่านไม่ได้เลย หรืออ่านได้แต่ score ต่ำกว่าเกณฑ์
        if mrz is None or best_score < MIN_ACCEPTABLE_SCORE:
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as enh_file:
                    enhanced_path = enh_file.name
                enhance_image(ocr_input_path, enhanced_path)

                mrz_enhanced = read_mrz(enhanced_path)
                enhanced_score = getattr(mrz_enhanced, "valid_score", 0) if mrz_enhanced is not None else -1

                # ใช้ผลลัพธ์ที่ score สูงกว่า (ถ้าอันแรกอ่านไม่ได้เลย ใช้อันที่สองไปเลย)
                if enhanced_score > best_score:
                    mrz = mrz_enhanced
                    best_score = enhanced_score

            except Exception as img_err:
                print(f"Image enhancement failed: {img_err}")

        if mrz is None:
            return jsonify({
                "success": False,
                "error": "Could not detect or read MRZ zone in the image"
            }), 422

        mrz_data = mrz.to_dict()

        passport_num = mrz_data.get("number") or mrz_data.get("passport_number") or ""
        surname = clean_name_field(mrz_data.get("surname") or "")

        raw_given_names = (
            mrz_data.get("names")
            or mrz_data.get("given_name")
            or mrz_data.get("given_names")
            or ""
        )
        given_names = clean_name_field(raw_given_names)

        nationality = mrz_data.get("nationality") or mrz_data.get("country") or ""
        sex = mrz_data.get("sex") or ""

        return jsonify({
            "success": True,
            "data": {
                "raw_text": getattr(mrz, "raw_text", ""),
                "valid_score": best_score,
                "passport_number": passport_num,
                "date_of_birth": mrz_data.get("date_of_birth"),
                "expiration_date": mrz_data.get("expiration_date"),
                "nationality": nationality,
                "surname": surname,
                "given_names": given_names,
                "sex": sex,
                "issuing_country": mrz_data.get("country")
            }
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

        if downscaled_path and os.path.exists(downscaled_path):
            os.remove(downscaled_path)

        if enhanced_path and os.path.exists(enhanced_path):
            os.remove(enhanced_path)
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
const MAIN_FOLDER_NAME = "interview"; // ชื่อโฟลเดอร์หลักใน Google Drive
const RENDER_OCR_URL = "https://passport-ocr-bot1.onrender.com/ocr"; // URL ของ Render OCR Service
const SECRET_TOKEN = "hkt12345604"; // Secret Token สำหรับ Webhook Verification
// ==========================================
// MAIN WEBHOOK (doPost)
// ==========================================
function doPost(e) {
try {
// ตรวจสอบ Secret Token เพื่อความปลอดภัย
if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
return ContentService.createTextOutput(JSON.stringify({ status: 'unauthorized' }))
.setMimeType(ContentService.MimeType.JSON);
}
const events = JSON.parse(e.postData.contents).events;
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
// 1. จัดการคำสั่งเปลี่ยนไฟล์/เริ่มต้นใหม่ (Sticker หรือ พิมพ์ EXIT/EXIT/emoji)
if (isResetCommand(event)) {
clearAllUserProperties(userProperties, userId);
sendSheetFlexMenu(event.replyToken);
return;
}
// 2. จัดการคำสั่งหยุดทำงาน (STOP)
if (isStopCommand(event)) {
clearAllUserProperties(userProperties, userId);
replyText(event.replyToken, '🛑 หยุดการใช้งานเรียบร้อยแล้ว\n\nหากต้องการกลับมาใช้งานใหม่ พิมพ์ "EXIT" หรือส่งสติ๊กเกอร์เข้ามาได้เลยครับ');
return;
}
// 3. จัดการการกดปุ่ม (Postback Event)
if (event.type === 'postback') {
const data = parseQueryString(event.postback.data);
// 3.1 เลือกแผ่นงาน Google Sheets
if (data.action === 'select_sheet') {
userProperties.setProperty(userId + '_sheetId', data.sheetId);
userProperties.setProperty(userId + '_sheetName', data.sheetName);
userProperties.deleteProperty(userId + '_seq');
userProperties.deleteProperty(userId + '_photoType');
userProperties.setProperty(userId + '_awaitingSeq', 'true');
replySeqPromptWithBookingOption(
event.replyToken,
`📊 คุณเลือกแผ่นงาน: "${data.sheetName}"\n\nกรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ หรือกดปุ่ม "จอง SEQ" ด้านล่าง:`
);
return;
}
// 3.2 เลือกประเภทรูปภาพ (PASSPORT, Return Ticket, Accomodation, ETC)
if (data.action === 'select_type') {
const seq = userProperties.getProperty(userId + '_seq');
userProperties.setProperty(userId + '_photoType', data.type);
if (data.type === 'ETC') {
replyTextWithFinishButton(
event.replyToken,
`📸 คุณเลือกประเภท: [ETC]\nคุณสามารถถ่าย/ส่งรูปภาพต่อเนื่องกี่รูปก็ได้ ระบบจะบันทึกเรียงต่อกันไปเรื่อยๆ\n\nเมื่อถ่ายเสร็จแล้ว ให้กดปุ่ม "เสร็จสิ้น" หรือส่งสติ๊กเกอร์เพื่อเปลี่ยน SEQ`
);
} else {
replyText(event.replyToken, `📸 คุณเลือกประเภท: [${data.type}]\nกรุณาถ่ายรูป หรือส่งรูปภาพเข้ามาได้เลยครับ`);
}
return;
}
// 3.3 กดปุ่ม "จอง SEQ"
if (data.action === 'book_seq') {
userProperties.setProperty(userId + '_awaitingBookingCount', 'true');
userProperties.deleteProperty(userId + '_awaitingSeq');
replyText(event.replyToken, '📌 ต้องการจอง SEQ กี่คนครับ? (กรุณากรอกตัวเลข เช่น 1, 2, 3)');
return;
}
// 3.4 กดปุ่ม "เปลี่ยน/จบ SEQ"
if (data.action === 'change_seq' || data.action === 'finish_seq') {
userProperties.deleteProperty(userId + '_seq');
userProperties.deleteProperty(userId + '_photoType');
userProperties.setProperty(userId + '_awaitingSeq', 'true');
replySeqPromptWithBookingOption(event.replyToken, 'กรุณาพิมพ์หมายเลข SEQ ถัดไปที่ต้องการจัดการ:');
return;
}
// 3.5 กดปุ่ม "แก้ไข Flight No."
if (data.action === 'edit_flight') {
userProperties.setProperty(userId + '_editingFlightSeq', data.seq);
replyText(event.replyToken, `✈️ กรุณากรอก Flight No. ใหม่สำหรับ SEQ ${data.seq}:`);
return;
}
// 3.6 กดปุ่ม "เสร็จสิ้น" (ถ่าย ETC ครบแล้ว)
if (data.action === 'finish_etc') {
const finishedSeq = userProperties.getProperty(userId + '_seq');
userProperties.deleteProperty(userId + '_photoType');
replyPhotoTypeSelection(
event.replyToken,
finishedSeq,
`✅ จบการบันทึกรูป ETC สำหรับ SEQ ${finishedSeq} เรียบร้อยแล้ว!\n\nคุณต้องการถ่ายรูปประเภทอื่นต่อสำหรับ SEQ นี้หรือไม่?`
);
return;
}
}
// 4. จัดการเมื่อผู้ใช้ส่งข้อความ (Text Event)
if (event.type === 'message' && event.message.type === 'text') {
const text = event.message.text.trim();
const currentSheetId = userProperties.getProperty(userId + '_sheetId');
if (!currentSheetId) {
sendSheetFlexMenu(event.replyToken);
return;
}
// 4.1 อยู่ในขั้นตอน "แก้ไข Flight No." เฉพาะบุคคล
const editingFlightSeq = userProperties.getProperty(userId + '_editingFlightSeq');
if (editingFlightSeq) {
const formattedFlightNo = formatFlightNo(text);
try {
updateFlightNoInSummarySheet(currentSheetId, editingFlightSeq, formattedFlightNo);
userProperties.deleteProperty(userId + '_editingFlightSeq');
const currentSeq = userProperties.getProperty(userId + '_seq') || editingFlightSeq;
replyPhotoTypeSelection(
event.replyToken,
currentSeq,
`✅ อัปเดต Flight No. เป็น "${formattedFlightNo}" สำหรับ SEQ ${editingFlightSeq} เรียบร้อยแล้ว!\n\nกรุณาเลือกประเภทรูปภาพที่ต้องการถ่ายต่อ:`
);
} catch (err) {
console.error('Update Flight Error: ' + err);
replyText(event.replyToken, `❌ เกิดข้อผิดพลาดในการอัปเดต Flight No.: ${err.message}`);
}
return;
}
// 4.2 อยู่ในขั้นตอนกรอก Flight No. หลังจากการจองกลุ่ม
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
// 4.3 ถ้าผู้ใช้พิมพ์ "จอง SEQ"
if (text === 'จองSEQ' || text === 'จอง SEQ' || text.toLowerCase() === 'book seq') {
userProperties.setProperty(userId + '_awaitingBookingCount', 'true');
userProperties.deleteProperty(userId + '_awaitingSeq');
replyText(event.replyToken, '📌 ต้องการจอง SEQ กี่คนครับ? (กรุณากรอกตัวเลข เช่น 1, 2, 3)');
return;
}
// 4.4 อยู่ในขั้นตอนกรอกจำนวนคนจอง SEQ
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
replyText(event.replyToken, `❌ ${err.message || 'เกิดข้อผิดพลาดในการจอง SEQ กรุณาลองใหม่อีกครั้ง'}`);
}
return;
}
// 4.5 คำสั่งเปลี่ยน/จบ SEQ
if (text === 'เปลี่ยน SEQ' || text === 'จบ SEQ' || text.toLowerCase() === 'change seq') {
userProperties.deleteProperty(userId + '_seq');
userProperties.deleteProperty(userId + '_photoType');
userProperties.setProperty(userId + '_awaitingSeq', 'true');
replySeqPromptWithBookingOption(event.replyToken, 'กรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ:');
return;
}
// 4.6 อยู่ในขั้นตอนรอรับหมายเลข SEQ
const awaitingSeq = userProperties.getProperty(userId + '_awaitingSeq') === 'true';
if (awaitingSeq) {
userProperties.setProperty(userId + '_seq', text);
userProperties.deleteProperty(userId + '_awaitingSeq');
replyPhotoTypeSelection(event.replyToken, text, `ตั้งค่า SEQ: ${text} เรียบร้อยแล้ว\nกรุณาเลือกประเภทรูปภาพที่ต้องการถ่าย:`);
return;
}
replyChangeSeqPrompt(event.replyToken, `❓ ไม่เข้าใจข้อความ "${text}" ครับ\nหากต้องการเปลี่ยนหรือจบ SEQ ปัจจุบัน กดปุ่มด้านล่างได้เลย หรือพิมพ์ "EXIT" เพื่อเลือกแผ่นงานใหม่ / พิมพ์ "STOP" เพื่อหยุดทำงาน`);
return;
}
// 5. จัดการเมื่อผู้ใช้ส่งรูปภาพ (Image Event)
if (event.type === 'message' && event.message.type === 'image') {
const sheetId = userProperties.getProperty(userId + '_sheetId');
const sheetName = userProperties.getProperty(userId + '_sheetName');
const seq = userProperties.getProperty(userId + '_seq');
const photoType = userProperties.getProperty(userId + '_photoType');
if (!sheetId || !seq || !photoType) {
replyText(event.replyToken, '⚠️ กรุณาเริ่มขั้นตอนใหม่โดยการพิมพ์ "EXIT" หรือเลือก SEQ และประเภทรูปภาพให้ครบก่อนครับ');
return;
}
try {
const targetRow = findSeqRowInSheet(sheetId, seq);
if (targetRow === -1) {
replyText(event.replyToken, `❌ ไม่พบหมายเลข SEQ "${seq}" ในคอลัมน์ A ของแท็บ PHOTO\n\nระบบยกเลิกการบันทึกรูปภาพเรียบร้อยแล้ว กรุณาตรวจสอบ SEQ แล้วลองใหม่อีกครั้งครับ`);
return;
}
const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
const fileName = `${seq}_${photoType}_${sheetName}.jpg`;
deleteExistingDriveFile(folder, fileName);
const imageBlob = getImageBlobFromLine(event.message.id);
imageBlob.setName(fileName);
const file = folder.createFile(imageBlob);
file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;
saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl);
let extraOcrMessage = "";
if (photoType === 'PASSPORT') {
const ocrResult = processPassportOCR(sheetId, seq, imageBlob);
if (ocrResult.status === 'SUCCESS') {
const genderText = ocrResult.sex === 'M' ? 'ชาย (ลง Col I)' : (ocrResult.sex === 'F' ? 'หญิง (ลง Col J)' : 'ไม่ระบุ');
extraOcrMessage = `\n\n🔍 **ผล OCR PASSPORT (Hybrid VIZ+MRZ):**\n• สัญชาติ: ${ocrResult.nat || '-'}\n• เลขพาสปอร์ต: ${ocrResult.passportNo || '-'}\n• ชื่อ-สกุล: ${ocrResult.name || '-'}\n• เพศ: ${genderText}`;
} else {
extraOcrMessage = `\n\n⚠️ **คำเตือน OCR:** ไม่สามารถอ่านข้อมูลพาสปอร์ตได้ กรุณาถ่ายใหม่อีกครั้ง โดยเน้นให้ตัวหนังสือและแถบด้านล่างชัดเจน ไม่สะท้อนแสง`;
}
}
if (photoType === 'ETC') {
replyTextWithFinishButton(event.replyToken, `✅ บันทึกรูป ETC ลงในคอลัมน์เรียบร้อยแล้ว!\n\nคุณสามารถส่งรูป ETC รูปถัดไปได้ทันที หรือกดปุ่ม "เสร็จสิ้น" หากถ่ายครบแล้ว`);
} else {
userProperties.deleteProperty(userId + '_photoType');
replyPhotoTypeSelection(event.replyToken, seq, `✅ บันทึกรูป [${photoType}] สำหรับ SEQ ${seq} เรียบร้อยแล้ว!${extraOcrMessage}\n\nต้องการถ่ายรูปประเภทอื่นเพิ่มสำหรับ SEQ นี้หรือไม่?`);
}
} catch (err) {
console.error('Image handling error: ' + err);
replyText(event.replyToken, `❌ ${err.message || 'เกิดข้อผิดพลาดระหว่างบันทึกรูปภาพ กรุณาลองใหม่อีกครั้ง'}`);
}
}
}
// ==========================================
// HELPER FUNCTIONS & BOOKING LOGIC
// ==========================================
function formatFlightNo(rawFlightNo) {
if (!rawFlightNo) return '';
return String(rawFlightNo)
.replace(/[^A-Za-z0-9]/g, '')
.toUpperCase();
}
function clearAllUserProperties(userProperties, userId) {
userProperties.deleteProperty(userId + '_sheetId');
userProperties.deleteProperty(userId + '_sheetName');
userProperties.deleteProperty(userId + '_seq');
userProperties.deleteProperty(userId + '_photoType');
userProperties.deleteProperty(userId + '_awaitingSeq');
userProperties.deleteProperty(userId + '_awaitingBookingCount');
userProperties.deleteProperty(userId + '_pendingFlightSeqs');
userProperties.deleteProperty(userId + '_editingFlightSeq');
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
console.error('Get Profile Error: ' + e);
return 'ผู้ใช้งาน';
}
}
function processBookingInSummarySheet(sheetId, count, userName) {
const ss = SpreadsheetApp.openById(sheetId);
const summarySheet = ss.getSheetByName('SUMMARY');
if (!summarySheet) {
throw new Error('ไม่พบแท็บ "SUMMARY" ในระบบ');
}
const lastRow = summarySheet.getLastRow();
if (lastRow < 2) {
throw new Error('ไม่พบข้อมูลแถว SEQ ในแท็บ SUMMARY');
}
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
if (bookedSeqs.length === 0) {
throw new Error('ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ');
}
return bookedSeqs;
}
function updateFlightNoInSummarySheet(sheetId, seqList, flightNo) {
const ss = SpreadsheetApp.openById(sheetId);
const summarySheet = ss.getSheetByName('SUMMARY');
if (!summarySheet) {
throw new Error('ไม่พบแท็บ "SUMMARY" ในระบบ');
}
const data = summarySheet.getDataRange().getValues();
const seqsToUpdate = Array.isArray(seqList) ? seqList.map(s => String(s).trim()) : [String(seqList).trim()];
for (let i = 1; i < data.length; i++) {
const currentSeq = String(data[i][0]).trim();
if (seqsToUpdate.includes(currentSeq)) {
summarySheet.getRange(i + 1, 3).setValue(flightNo); // Col C
}
}
}
function isStopCommand(event) {
if (event.type === 'message' && event.message.type === 'text') {
const text = event.message.text.trim().toLowerCase();
if (text === 'stop') return true;
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
if (subFolders.hasNext()) {
return subFolders.next();
} else {
return photoFolder.createFolder(sheetName);
}
}
function deleteExistingDriveFile(folder, fileName) {
const existingFiles = folder.getFilesByName(fileName);
while (existingFiles.hasNext()) {
const oldFile = existingFiles.next();
oldFile.setTrashed(true);
}
}
function findSeqRowInSheet(sheetId, seq) {
const ss = SpreadsheetApp.openById(sheetId);
const sheet = ss.getSheetByName('PHOTO');
if (!sheet) {
throw new Error('ไม่พบแท็บชื่อ PHOTO ในไฟล์ Google Sheets นี้');
}
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
if (photoType === 'PASSPORT') {
sheet.getRange(targetRow, 4).setValue(imageFormula);
} else if (photoType === 'Return Ticket') {
sheet.getRange(targetRow, 5).setValue(imageFormula);
} else if (photoType === 'Accomodation') {
sheet.getRange(targetRow, 6).setValue(imageFormula);
} else if (photoType === 'ETC') {
let targetCol = 7;
while (sheet.getRange(targetRow, targetCol).getValue() !== '') {
targetCol++;
}
sheet.getRange(targetRow, targetCol).setValue(imageFormula);
}
}
// ==========================================
// 🔍 HYBRID VIZ + MRZ PASSPORT OCR LOGIC
// ==========================================
function processPassportOCR(sheetId, seq, imageBlob) {
const ss = SpreadsheetApp.openById(sheetId);
const summarySheet = ss.getSheetByName('SUMMARY');
if (!summarySheet) {
throw new Error('ไม่พบแท็บ "SUMMARY" ในระบบ');
}
const data = summarySheet.getDataRange().getValues();
let targetRow = -1;
for (let i = 1; i < data.length; i++) {
if (String(data[i][0]).trim() === String(seq).trim()) {
targetRow = i + 1;
break;
}
}
if (targetRow === -1) {
return { status: 'NOT_FOUND' };
}
const parsedData = callExternalPassportOcr(imageBlob);
if (parsedData) {
// --------------------------------------------------
// 1. HELPER FUNCTIONS
// --------------------------------------------------
const cleanAlphaOnly = (str) => {
if (!str) return '';
return String(str)
.replace(/[^A-Za-z]/g, '')
.toUpperCase()
.trim();
};
// ตรวจจับ "คำขยะ" ที่ OCR อ่านมั่วจากเส้น/รอยเปื้อนในรูป เช่น KKKKKGGGGG, KSKK
// หลักการ: คำจริง (ชื่อคน) แทบทุกภาษาที่เขียนด้วยอักษรโรมันจะมีสระอย่างน้อย 1 ตัว
// และไม่มีตัวอักษรเดิมซ้ำติดกันยาวๆ แบบ KKKK หรือ GGGG
const isNoiseToken = (word) => {
if (!word) return true;
// กติกาที่ 1: มีตัวอักษรเดียวกันซ้ำติดกันตั้งแต่ 3 ตัวขึ้นไป (เช่น KKK, GGGG) = ขยะ
if (/(.)\1{2,}/.test(word)) return true;
// กติกาที่ 2: ความยาว >= 3 ตัวอักษร แต่ไม่มีสระเลย (รวม Y) = ขยะ (คำชื่อจริงแทบไม่มีแบบนี้)
if (word.length >= 3 && !/[AEIOUY]/.test(word)) return true;
return false;
};
const filterNoiseWords = (wordsArray) => {
return wordsArray
.map(w => cleanAlphaOnly(w))
.filter(w => w && w.length >= 2 && !isNoiseToken(w)); // กรองขยะตัวเดียว + คำขยะจาก OCR ออก
};
const nationality = cleanAlphaOnly(parsedData.nationality);
let passportNo = parsedData.passport_number ? String(parsedData.passport_number).replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim() : '';
// --------------------------------------------------
// 2. VIZ PARSING (Visual Inspection Zone)
// --------------------------------------------------
let vizSurname = cleanAlphaOnly(parsedData.surname);
if (isNoiseToken(vizSurname)) vizSurname = '';
let vizGivenNames = '';
if (parsedData.given_names) {
const rawGiven = String(parsedData.given_names).replace(/</g, ' ');
vizGivenNames = filterNoiseWords(rawGiven.split(/\s+/)).join(' ');
}
// --------------------------------------------------
// 3. MRZ PARSING (Machine Readable Zone)
// --------------------------------------------------
let mrzSurname = '';
let mrzGivenNames = '';
let rawLine1 = '';
if (parsedData.raw_text) {
const lines = String(parsedData.raw_text).split('\n');
for (const line of lines) {
const cleanLine = line.replace(/\s+/g, '').toUpperCase();
if (cleanLine.includes('P<') || cleanLine.length >= 30) {
rawLine1 = cleanLine;
break;
}
}
}
if (rawLine1) {
let nameField = rawLine1;
const pIndex = nameField.indexOf('P<');
if (pIndex !== -1 && nameField.length >= pIndex + 5) {
nameField = nameField.substring(pIndex + 5);
}
// ตัดเครื่องหมาย < ท้ายสายทิ้งทั้งหมด
nameField = nameField.replace(/<+$/, '');
const mainParts = nameField.split('<<');
if (mainParts.length >= 2) {
mrzSurname = cleanAlphaOnly(mainParts[0]);
if (isNoiseToken(mrzSurname)) mrzSurname = '';
const givenSection = mainParts[1].replace(/<+$/, '');
const rawMrzGivenParts = givenSection.split('<');
mrzGivenNames = filterNoiseWords(rawMrzGivenParts).join(' ');
} else if (mainParts.length === 1) {
mrzSurname = cleanAlphaOnly(mainParts[0]);
if (isNoiseToken(mrzSurname)) mrzSurname = '';
}
}
// --------------------------------------------------
// 4. HYBRID DECISION
// --------------------------------------------------
const surname = vizSurname || mrzSurname;
const givenNames = vizGivenNames || mrzGivenNames;
const fullName = `${givenNames} ${surname}`.replace(/\s+/g, ' ').trim();
// บันทึกลง Sheet SUMMARY
if (nationality) summarySheet.getRange(targetRow, 4).setValue(nationality); // Col D
if (passportNo) summarySheet.getRange(targetRow, 5).setValue(passportNo); // Col E
if (fullName) summarySheet.getRange(targetRow, 6).setValue(fullName); // Col F
// เพศ
let sex = cleanAlphaOnly(parsedData.sex);
if (sex !== 'M' && sex !== 'F' && parsedData.raw_text) {
const raw = String(parsedData.raw_text).toUpperCase();
if (raw.includes(' M ') || raw.includes('<M<')) sex = 'M';
else if (raw.includes(' F ') || raw.includes('<F<')) sex = 'F';
}
if (sex === 'M') {
summarySheet.getRange(targetRow, 9).setValue(1);
summarySheet.getRange(targetRow, 10).setValue('');
} else if (sex === 'F') {
summarySheet.getRange(targetRow, 9).setValue('');
summarySheet.getRange(targetRow, 10).setValue(1);
}
if (passportNo || fullName) {
return {
status: 'SUCCESS',
nat: nationality,
passportNo: passportNo,
name: fullName,
sex: sex
};
}
}
return { status: 'UNMATCHED' };
}
function callExternalPassportOcr(imageBlob) {
try {
const boundary = "---------------------------" + new Date().getTime().toString(16);
const filename = imageBlob.getName() || "passport.jpg";
const contentType = imageBlob.getContentType() || "image/jpeg";
const bytes = imageBlob.getBytes();
const header = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
const footer = `\r\n--${boundary}--\r\n`;
const headerBytes = Utilities.newBlob(header).getBytes();
const footerBytes = Utilities.newBlob(footer).getBytes();
// ✅ ต่อไบต์อาเรย์ตรงๆ ไม่ผ่าน base64 เลย ป้องกันปัญหา padding (=) แทรกกลางข้อมูลรูปภาพ
const payload = headerBytes.concat(bytes).concat(footerBytes);
const options = {
method: "post",
contentType: "multipart/form-data; boundary=" + boundary,
payload: payload,
muteHttpExceptions: true
};
const response = UrlFetchApp.fetch(RENDER_OCR_URL, options);
if (response.getResponseCode() === 200) {
const resJson = JSON.parse(response.getContentText());
if (resJson.success && resJson.data) {
return resJson.data;
}
}
console.error("OCR API Response Error: " + response.getContentText());
return null;
} catch (err) {
console.error("External OCR API Exception: " + err.toString());
return null;
}
}
// ==========================================
// MENU & FLEX MESSAGE FUNCTIONS
// ==========================================
function findAllSheetsRecursive(folder, pathPrefix) {
let results = [];
const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
while (files.hasNext()) {
const file = files.next();
results.push({
id: file.getId(),
name: file.getName(),
path: pathPrefix,
updated: file.getLastUpdated().getTime()
});
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
{
type: 'box',
layout: 'vertical',
margin: 'md',
spacing: 'sm',
contents: buttons
}
]
}
}
};
sendLineReply(replyToken, [flexMessage]);
}
function replyPhotoTypeSelection(replyToken, seq, headerText) {
const message = {
type: 'flex',
altText: 'เลือกประเภทรูปภาพ',
contents: {
type: 'bubble',
body: {
type: 'box',
layout: 'vertical',
contents: [
{ type: 'text', text: headerText, wrap: true, weight: 'bold', size: 'md' },
{ type: 'separator', margin: 'md' },
{
type: 'box',
layout: 'vertical',
margin: 'md',
spacing: 'sm',
contents: [
createButton('PASSPORT (คอลัมน์ D)', 'PASSPORT'),
createButton('Return Ticket (คอลัมน์ E)', 'Return Ticket'),
createButton('Accomodation (คอลัมน์ F)', 'Accomodation'),
createButton('ETC (คอลัมน์ G ถัดไปรัวๆ)', 'ETC'),
createEditFlightButton(seq)
]
},
{ type: 'separator', margin: 'md' },
{
type: 'box',
layout: 'vertical',
margin: 'md',
spacing: 'sm',
contents: [
createFinishSeqButton()
]
}
]
}
}
};
sendLineReply(replyToken, [message]);
}
function createButton(label, type) {
return {
type: 'button',
style: 'primary',
height: 'sm',
action: {
type: 'postback',
label: label,
data: `action=select_type&type=${type}`,
displayText: `เลือก: ${type}`
}
};
}
function createEditFlightButton(seq) {
return {
type: 'button',
style: 'secondary',
height: 'sm',
action: {
type: 'postback',
label: '✈️ แก้ไข Flight No.',
data: `action=edit_flight&seq=${seq}`,
displayText: 'แก้ไข Flight No.'
}
};
}
function createFinishSeqButton() {
return {
type: 'button',
style: 'secondary',
height: 'sm',
action: {
type: 'postback',
label: '✅ จบ SEQ นี้ (ไปเลขถัดไป)',
data: 'action=finish_seq',
displayText: 'จบ SEQ นี้'
}
};
}
function replySeqPromptWithBookingOption(replyToken, textMessage) {
const message = {
type: 'text',
text: textMessage,
quickReply: {
items: [
{
type: 'action',
action: {
type: 'postback',
label: '📌 จอง SEQ',
data: 'action=book_seq',
displayText: 'จองSEQ'
}
}
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
{
type: 'action',
action: {
type: 'postback',
label: '🔢 เปลี่ยน SEQ',
data: 'action=change_seq',
displayText: 'ขอเปลี่ยน SEQ'
}
},
{
type: 'action',
action: {
type: 'postback',
label: '📌 จอง SEQ',
data: 'action=book_seq',
displayText: 'จองSEQ'
}
}
]
}
};
sendLineReply(replyToken, [message]);
}
function replyTextWithFinishButton(replyToken, textMessage) {
const message = {
type: 'text',
text: textMessage,
quickReply: {
items: [
{
type: 'action',
action: {
type: 'postback',
label: '🏁 เสร็จสิ้น (จบงาน ETC)',
data: 'action=finish_etc',
displayText: 'เสร็จสิ้นการถ่ายรูป ETC'
}
}
]
}
};
sendLineReply(replyToken, [message]);
}
function getImageBlobFromLine(messageId) {
const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
const response = UrlFetchApp.fetch(url, {
headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN }
});
return response.getBlob();
}
function replyText(replyToken, text) {
sendLineReply(replyToken, [{ type: 'text', text: text }]);
}
function sendLineReply(replyToken, messages) {
UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
},
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
1. วางทับไฟล์ `app.py` เดิมใน repository ของคุณ (ไฟล์ `requirements.txt` และ `Dockerfile` เหมือนเดิม ไม่ต้องแก้)
2. Commit และ push ขึ้น repository
3. Render จะ build และ deploy ให้อัตโนมัติ (หรือกด **Manual Deploy** ใน Render dashboard เพื่อบังคับ deploy ทันที)

### 2. ฝั่ง Apps Script (Google Sheets)
1. เปิดโปรเจกต์ Google Apps Script ของคุณ
2. เลือกโค้ดทั้งหมดในไฟล์ `Code.gs` เดิม (Ctrl+A) แล้วลบทิ้ง
3. คัดลอกเฉพาะโค้ดในบล็อก ` ```javascript ` ด้านบน (ตั้งแต่ `// ==========================================` จนถึงปิดท้ายฟังก์ชัน `parseQueryString`) แล้ววางแทนที่
4. บันทึก (Ctrl+S)
5. **สำคัญ:** ไปที่ **Deploy > Manage deployments** → กดไอคอนดินสอ (Edit) ที่ deployment ที่ใช้งานอยู่ → ตรง Version เลือก **New version** → กด **Deploy**
   - ⚠️ การกดบันทึกอย่างเดียวไม่พอ ต้อง Deploy เวอร์ชันใหม่เสมอ ไม่งั้นเว็บแอปจะยังรันโค้ดเวอร์ชันเก่าอยู่

### ⚠️ ข้อควรระวังตอนคัดลอกโค้ด
- **อย่าคัดลอกทั้งไฟล์ Markdown นี้** ไปวางในทั้ง Apps Script และ Server ตรงๆ เพราะไฟล์นี้มีข้อความอธิบายภาษาไทยและเครื่องหมาย ` ``` ` ปนอยู่ ซึ่งไม่ใช่โค้ดที่รันได้
- ให้คัดลอก **เฉพาะเนื้อหาภายในบล็อกโค้ดแต่ละภาษา** (JavaScript ไปไว้ใน `Code.gs`, Python ไปไว้ใน `app.py`) เท่านั้น

### 3. ทดสอบ
- **OCR ชื่อ-นามสกุล:** ถ่ายรูปพาสปอร์ตที่เคยเจอปัญหาชื่อขยะ (`YUBIN KKKKKGGGGG KSKK ZHANG`) ซ้ำอีกครั้ง ควรจะได้ผลลัพธ์ที่ถูกต้อง (`YUBIN ZHANG`)
- **ความเสถียรของการส่งรูป:** ถ่ายพาสปอร์ตติดกันหลายรอบ โดยเฉพาะรอบที่ชื่อไฟล์ยาวไม่เท่ากัน (เช่น SEQ001 vs SEQ012) ควรอ่าน OCR สำเร็จทุกครั้ง ไม่มีอาการหลุดเป็นบางรอบหรือไม่มี log ขึ้นที่ฝั่ง Render
- **ขั้นตอน SEQ หลังกรอก Flight No.:** จอง SEQ กลุ่ม → กรอก Flight No. → พิมพ์หมายเลข SEQ ตามที่ระบบถาม ควรเข้าสู่ขั้นตอนเลือกประเภทรูปภาพได้ปกติ ไม่ขึ้น "ไม่เข้าใจข้อความ"

---

## ประวัติการแก้ไข (Changelog)

| วันที่ | ปัญหา | จุดที่แก้ | สรุปการแก้ไข |
|---|---|---|---|
| ครั้งที่ 1 | อ่านชื่อ-นามสกุลผิดพลาด มีคำขยะจาก OCR (`KKKKKGGGGG`, `KSKK`) | `app.py` (`clean_name_field`, `is_noise_token`) + `Code.gs` (`isNoiseToken`) | กรองคำขยะ 2 ชั้น ทั้งฝั่ง Server และ Apps Script |
| ครั้งที่ 2 | ส่งรูปไป OCR Server ล้มเหลวแบบสุ่ม | `Code.gs` (`callExternalPassportOcr`) | เปลี่ยนจากต่อสตริง base64 มาต่อไบต์อาเรย์ (`.concat()`) ตรงๆ แก้ปัญหา padding แทรกกลางไฟล์ภาพ |
| ครั้งที่ 3 | บอทตอบ "ไม่เข้าใจข้อความ" หลังกรอก Flight No. เสร็จ | `Code.gs` (`handleEvent`, ส่วน 4.2) | เพิ่มการตั้งค่า `_awaitingSeq` เป็น `'true'` ก่อนถามหมายเลข SEQ ถัดไป |
