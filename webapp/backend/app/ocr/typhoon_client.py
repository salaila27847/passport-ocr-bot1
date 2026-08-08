"""
เรียก Typhoon OCR (https://opentyphoon.ai) ผ่าน OpenAI-compatible chat completions API
รูปแบบการเรียก (base_url, message ที่มี image_url เป็น data URI, extra_body) อ้างอิงจาก
โค้ดต้นทางจริงของแพ็กเกจ typhoon-ocr (scb-10x/typhoon-ocr, ocr_utils.py:ocr_document) —
ไม่ได้ใช้แพ็กเกจนั้นตรงๆ เพราะ ocr_document() ผูก prompt ไว้ตายตัวสำหรับแปลงเอกสารทั้งหน้าเป็น markdown
ส่วนที่นี่ต้องการดึงฟิลด์เฉพาะเจาะจง (ชื่อ/เลขไฟลต์/ชื่อโรงแรม) เป็น JSON ตรงๆ เลยเขียน prompt เอง
"""
import asyncio
import io
import json

from openai import OpenAI
from PIL import Image

from app.config import settings

MAX_IMAGE_DIMENSION = 1800


class TyphoonOcrError(Exception):
    pass


def _client() -> OpenAI:
    if not settings.typhoon_api_key:
        raise TyphoonOcrError("TYPHOON_API_KEY is not set")
    return OpenAI(base_url=settings.typhoon_base_url, api_key=settings.typhoon_api_key)


def _image_to_base64(image_bytes: bytes) -> str:
    import base64

    img = Image.open(io.BytesIO(image_bytes))
    width, height = img.size
    longest_side = max(width, height)
    if longest_side > MAX_IMAGE_DIMENSION:
        scale = MAX_IMAGE_DIMENSION / longest_side
        img = img.resize((int(width * scale), int(height * scale)), Image.Resampling.LANCZOS)
    img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _extract_json_object(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}


def _call_sync(image_bytes: bytes, prompt: str) -> dict:
    try:
        image_b64 = _image_to_base64(image_bytes)
        client = _client()
        response = client.chat.completions.create(
            model="typhoon-ocr",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    ],
                }
            ],
            max_tokens=1024,
            extra_body={"temperature": 0.1, "top_p": 0.6},
        )
    except TyphoonOcrError:
        raise
    except Exception as exc:
        raise TyphoonOcrError(str(exc)) from exc

    content = response.choices[0].message.content if response.choices else ""
    return _extract_json_object(content)


async def _call(image_bytes: bytes, prompt: str) -> dict:
    return await asyncio.to_thread(_call_sync, image_bytes, prompt)


PASSPORT_NAME_PROMPT = (
    "This is a photo of a passport bio-data page. Read ONLY the printed name field near the top "
    "of the page (NOT the machine-readable zone / MRZ lines at the bottom).\n"
    'Respond with ONLY a JSON object, no other text: {"full_name": "<name as printed, or empty string if unreadable>"}'
)

TICKET_FIELDS_PROMPT = (
    "This is a photo of a flight ticket or booking confirmation. Extract the flight number and "
    "travel date if visible.\n"
    "Respond with ONLY a JSON object, no other text: "
    '{"flight_no": "<e.g. TG123, or empty string if not visible>", "travel_date": "<as printed, or empty string>"}'
)

ACCOMMODATION_FIELDS_PROMPT = (
    "This is a photo of a hotel/accommodation booking confirmation. Extract the hotel name and "
    "check-in date if visible.\n"
    "Respond with ONLY a JSON object, no other text: "
    '{"hotel_name": "<or empty string if not visible>", "check_in_date": "<as printed, or empty string>"}'
)


async def extract_passport_name(image_bytes: bytes) -> str:
    result = await _call(image_bytes, PASSPORT_NAME_PROMPT)
    return str(result.get("full_name") or "").strip()


async def extract_ticket_fields(image_bytes: bytes) -> dict:
    result = await _call(image_bytes, TICKET_FIELDS_PROMPT)
    return {
        "flight_no": str(result.get("flight_no") or "").strip(),
        "travel_date": str(result.get("travel_date") or "").strip(),
    }


async def extract_accommodation_fields(image_bytes: bytes) -> dict:
    result = await _call(image_bytes, ACCOMMODATION_FIELDS_PROMPT)
    return {
        "hotel_name": str(result.get("hotel_name") or "").strip(),
        "check_in_date": str(result.get("check_in_date") or "").strip(),
    }
