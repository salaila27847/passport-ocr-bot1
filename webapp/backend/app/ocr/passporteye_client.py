"""
พอร์ตจาก app.py เดิม (root ของรีโป) — เอาเฉพาะส่วน PassportEye/Tesseract
ตัด parse_mrz_line1_regex() ออกทั้งหมด (ไม่ใช้ regex เป็นแหล่งชื่อคู่แข่งอีกต่อไป — ใช้ PassportEye + Typhoon แทน)
is_noise_token()/clean_name_field() ยังเก็บไว้เพราะเป็นตัวกรอง junk token ของผลลัพธ์ PassportEye เอง ไม่ใช่แหล่งชื่อแยก
"""
import asyncio
import os
import re
import tempfile
from dataclasses import dataclass

from passporteye import read_mrz
from PIL import Image, ImageEnhance

MIN_ACCEPTABLE_SCORE = int(os.environ.get("MIN_ACCEPTABLE_SCORE", "70"))
MAX_DIMENSION = 1800
VOWELS = set("AEIOUY")


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


def _downscale_if_needed(src_path: str, dest_path: str) -> str:
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


def _enhance_image(src_path: str, dest_path: str) -> None:
    img = Image.open(src_path)
    width, height = img.size
    longest_side = max(width, height)
    if longest_side < 1000:
        img = img.resize((width * 2, height * 2), Image.Resampling.LANCZOS)
    img = ImageEnhance.Contrast(img).enhance(2.0)
    img = ImageEnhance.Sharpness(img).enhance(2.0)
    img.save(dest_path, quality=95)


@dataclass
class PassportEyeResult:
    valid_score: int
    passport_number: str = ""
    date_of_birth: str = ""
    expiration_date: str = ""
    issuing_country: str = ""
    nationality: str = ""
    nationality_mismatch: bool = False
    remark: str = ""
    surname: str = ""
    given_names: str = ""
    full_name: str = ""
    sex: str = ""


def _parse_mrz(image_path: str) -> "PassportEyeResult | None":
    try:
        mrz = read_mrz(image_path)
    except Exception:
        return None
    if mrz is None:
        return None

    mrz_data = mrz.to_dict()
    raw_text = getattr(mrz, "raw_text", "") or ""
    lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
    line1 = lines[0] if lines else ""
    line2 = lines[1] if len(lines) > 1 else ""

    passport_num = mrz_data.get("number") or mrz_data.get("passport_number") or ""
    surname = clean_name_field(mrz_data.get("surname") or "")
    raw_given = mrz_data.get("names") or mrz_data.get("given_name") or mrz_data.get("given_names") or ""
    given_names = clean_name_field(raw_given)
    full_name = f"{given_names} {surname}".strip()

    issuing_country = mrz_data.get("country") or (line1[2:5] if len(line1) >= 5 else "")
    nationality = line2 if len(line2) >= 13 else (mrz_data.get("nationality") or "")

    nationality_mismatch = bool(issuing_country and nationality and issuing_country != nationality)
    remark = "⚠️ สัญชาติไม่ตรงกับประเทศผู้ออกเล่ม" if nationality_mismatch else ""

    return PassportEyeResult(
        valid_score=getattr(mrz, "valid_score", 0) or 0,
        passport_number=passport_num,
        date_of_birth=mrz_data.get("date_of_birth") or "",
        expiration_date=mrz_data.get("expiration_date") or "",
        issuing_country=issuing_country,
        nationality=nationality,
        nationality_mismatch=nationality_mismatch,
        remark=remark,
        surname=surname,
        given_names=given_names,
        full_name=full_name,
        sex=mrz_data.get("sex") or "",
    )


def _run_pipeline_sync(image_bytes: bytes) -> "PassportEyeResult | None":
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
        temp_file.write(image_bytes)
        temp_path = temp_file.name

    ds_path = f"{temp_path}_ds.jpg"
    enhanced_path = f"{temp_path}_enh.jpg"
    try:
        ocr_input_path = _downscale_if_needed(temp_path, ds_path)

        result = _parse_mrz(ocr_input_path)
        best_score = result.valid_score if result else -1

        # ลองอ่านซ้ำด้วยรูปที่ enhance แล้ว (contrast/sharpen/upscale) ถ้าคะแนนแรกต่ำกว่าเกณฑ์
        if result is None or best_score < MIN_ACCEPTABLE_SCORE:
            try:
                _enhance_image(ocr_input_path, enhanced_path)
                enhanced_result = _parse_mrz(enhanced_path)
                if enhanced_result and enhanced_result.valid_score > best_score:
                    result = enhanced_result
            except Exception:
                pass  # enhance พังก็ไปต่อด้วยผลรอบแรก ไม่ทำให้ทั้ง pipeline ล้ม

        return result
    finally:
        for p in {temp_path, ds_path, enhanced_path}:
            if p and os.path.exists(p):
                os.remove(p)


async def run_passporteye(image_bytes: bytes) -> "PassportEyeResult | None":
    """คืน None ถ้าอ่าน MRZ ไม่เจอเลยทั้งสองรอบ (รอบปกติ + รอบ enhance)"""
    return await asyncio.to_thread(_run_pipeline_sync, image_bytes)
