import os
import tempfile
from flask import Flask, request, jsonify
from passporteye import read_mrz
from PIL import Image, ImageEnhance, ImageFilter

app = Flask(__name__)

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
        # 1. บันทึกไฟล์ต้นฉบับลง Temp
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        # 2. ลองอ่าน MRZ จากภาพต้นฉบับรอบที่ 1
        mrz = read_mrz(temp_path)

        # 3. ถ้ารอบแรกอ่านไม่เจอ (มักเกิดจากภาพโดน LINE บีบอัด) -> ให้ทำ Image Preprocessing เพิ่มความคมชัดแล้วลองใหม่
        if mrz is None:
            try:
                img = Image.open(temp_path)
                
                # ขยายขนาดภาพ 2 เท่า เพื่อให้ตัวหนังสือ MRZ ชัดขึ้นสำหรับ Tesseract OCR
                width, height = img.size
                img = img.resize((width * 2, height * 2), Image.Resampling.LANCZOS)
                
                # เพิ่ม Contrast ความเข้มตัวอักษร
                enhancer = ImageEnhance.Contrast(img)
                img = enhancer.enhance(2.0)
                
                # เพิ่ม Sharpness ความคม
                sharpness = ImageEnhance.Sharpness(img)
                img = sharpness.enhance(2.0)

                with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as enh_file:
                    img.save(enhanced_path := enh_file.name, quality=95)

                # ลองอ่าน MRZ รอบที่ 2 จากภาพที่ปรับแต่งแล้ว
                mrz = read_mrz(enhanced_path)
            except Exception as img_err:
                print(f"Image enhancement failed: {img_err}")

        # ถ้ารอบ 2 ยังอ่านไม่เจอจริงๆ
        if mrz is None:
            return jsonify({
                "success": False,
                "error": "Could not detect or read MRZ zone in the image"
            }), 422

        mrz_data = mrz.to_dict()
        
        # 4. ดึงข้อมูลแบบปลอดภัย (ดักจับ Key ทุกค่ายของ PassportEye)
        passport_num = mrz_data.get("number") or mrz_data.get("passport_number") or ""
        surname = mrz_data.get("surname") or ""
        
        # ชื่อมักจะเก็บในคีย์ 'names' หรือ 'given_name' หรือ 'given_names'
        given_names = mrz_data.get("names") or mrz_data.get("given_name") or mrz_data.get("given_names") or ""

        nationality = mrz_data.get("nationality") or mrz_data.get("country") or ""
        sex = mrz_data.get("sex") or ""

        return jsonify({
            "success": True,
            "data": {
                "raw_text": getattr(mrz, 'raw_text', ''),
                "valid_score": getattr(mrz, 'valid_score', 0),
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
        # ลบไฟล์ชั่วคราวทิ้งทุกครั้ง
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        if enhanced_path and os.path.exists(enhanced_path):
            os.remove(enhanced_path)
