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
