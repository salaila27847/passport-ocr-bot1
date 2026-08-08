"""
งานพื้นหลังหลังอัปโหลดรูป — เรียกผ่าน FastAPI BackgroundTasks ใน api.py ไม่บล็อกการตอบกลับ HTTP
ของการอัปโหลด (คงพฤติกรรม async pipeline เดิมของ app.py ที่ยิง OCR แบบ fire-and-forget)
"""
import asyncio

from app import sheets
from app.ocr.passporteye_client import run_passporteye
from app.ocr.typhoon_client import TyphoonOcrError, extract_passport_name, extract_ticket_fields


async def _safe_typhoon_passport_name(image_bytes: bytes) -> str:
    try:
        return await extract_passport_name(image_bytes)
    except TyphoonOcrError:
        return ""  # Typhoon ล่ม/ช้า/ไม่ได้ตั้ง API key -> ไปต่อด้วยผล PassportEye อย่างเดียว


async def run_passport_ocr_job(sheet_id: str, seq: str, image_bytes: bytes) -> None:
    """อ่าน MRZ ด้วย PassportEye + เทียบชื่อกับ Typhoon OCR พร้อมกัน แล้วเขียนผลลง OCR_RESULTS"""
    try:
        pe_result, typhoon_name = await asyncio.gather(
            run_passporteye(image_bytes),
            _safe_typhoon_passport_name(image_bytes),
        )
        if pe_result is None:
            await sheets.write_ocr_result(
                sheet_id, seq, success=False,
                error="ไม่สามารถอ่าน MRZ จากรูปภาพได้ กรุณาถ่ายรูปใหม่อีกครั้ง",
            )
            return
        await sheets.write_ocr_result(
            sheet_id, seq, success=True,
            nationality=pe_result.nationality,
            passport_no=pe_result.passport_number,
            sex=pe_result.sex,
            pe_name=pe_result.full_name,
            typhoon_name=typhoon_name,
            remark=pe_result.remark,
        )
    except Exception as exc:
        # กันไม่ให้ SEQ ค้างสถานะ "queued" ตลอดไปถ้ามี exception ที่ไม่คาดคิดหลุดออกมา
        await sheets.write_ocr_result(sheet_id, seq, success=False, error=str(exc))


async def run_ticket_ocr_job(sheet_id: str, seq: str, image_bytes: bytes) -> None:
    """ลองดึงเลข Flight No. อัตโนมัติจากรูปตั๋วด้วย Typhoon OCR ถ้าอ่านได้ให้เติมลงคอลัมน์ Flight No.
    ของ SEQ นี้ — เจ้าหน้าที่ยังแก้ไข/กรอกเองได้ตามปกติถ้า Typhoon ล่มหรืออ่านไม่ได้ ไม่ใช่ hard requirement"""
    try:
        fields = await extract_ticket_fields(image_bytes)
    except TyphoonOcrError:
        return
    if fields.get("flight_no"):
        await sheets.update_flight_no(sheet_id, [seq], fields["flight_no"])
