import os
import re
import tempfile
from flask import Flask, request, jsonify
from passporteye import read_mrz
from PIL import Image, ImageEnhance, ImageFilter

app = Flask(__name__)

# ค่า valid_score ต่ำสุดที่ยอมรับว่า "อ่านได้ดีพอ" โดยไม่ต้องลองซ้ำด้วยภาพที่ปรับปรุงแล้ว
MIN_ACCEPTABLE_SCORE = 70

VOWELS = set("AEIOUY")


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
    enhanced_path = None

    try:
        # 1. Save original image
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        # 2. First OCR attempt
        mrz = read_mrz(temp_path)
        best_score = getattr(mrz, "valid_score", 0) if mrz is not None else -1

        # 3. ลองอ่านซ้ำด้วยภาพที่ปรับปรุงแล้ว ถ้าอ่านไม่ได้เลย หรืออ่านได้แต่ score ต่ำกว่าเกณฑ์
        if mrz is None or best_score < MIN_ACCEPTABLE_SCORE:
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as enh_file:
                    enhanced_path = enh_file.name
                enhance_image(temp_path, enhanced_path)

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

        if enhanced_path and os.path.exists(enhanced_path):
            os.remove(enhanced_path)
