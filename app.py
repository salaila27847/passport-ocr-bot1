import os
import tempfile
from flask import Flask, request, jsonify
from passporteye import read_mrz

app = Flask(__name__)

@app.route('/', methods=['GET'])
def health_check():
    """Endpoint สำหรับตรวจสอบสถานะของ Server"""
    return jsonify({
        "status": "online",
        "message": "PassportEye OCR Service on Koyeb is ready!"
    }), 200

@app.route('/ocr/passport', methods=['POST'])
def process_passport():
    """Endpoint รับรูปภาพพาสปอร์ตผ่าน Multipart Form-Data เพื่ออ่าน MRZ"""
    if 'image' not in request.files:
        return jsonify({"success": False, "error": "No image file provided (Key must be 'image')"}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400

    temp_path = None
    try:
        # บันทึกไฟล์ลง Temporary Directory เพื่อประมวลผล
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            file.save(temp_path := temp_file.name)

        # ประมวลผล MRZ ด้วย PassportEye
        mrz = read_mrz(temp_path)

        if mrz is None:
            return jsonify({
                "success": False,
                "error": "Could not detect or read MRZ zone in the image"
            }), 422

        mrz_data = mrz.to_dict()
        
        # จัดรูปแบบข้อมูลตอบกลับ
        return jsonify({
            "success": True,
            "data": {
                "raw_text": mrz.raw_text,
                "valid_score": mrz.valid_score,
                "passport_number": mrz_data.get("number"),
                "date_of_birth": mrz_data.get("date_of_birth"),
                "expiration_date": mrz_data.get("expiration_date"),
                "nationality": mrz_data.get("nationality"),
                "surname": mrz_data.get("surname"),
                "given_names": mrz_data.get("names"),
                "sex": mrz_data.get("sex"),
                "issuing_country": mrz_data.get("country")
            }
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        # ลบไฟล์ชั่วคราวทิ้งทุกครั้ง
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port)