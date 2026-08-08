"""
ยืนยันตัวตนเจ้าหน้าที่ด้วย Google Sign-In (Google Identity Services บนฝั่ง frontend ส่ง ID token
มาที่ header Authorization: Bearer <token>) แทนการผูกกับ LINE userId เหมือนระบบเดิม
"""
import asyncio
from dataclasses import dataclass

from fastapi import Header, HTTPException
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from app.config import settings


@dataclass
class StaffUser:
    email: str
    name: str


def _is_allowed_email(email: str) -> bool:
    email_lower = email.lower()
    if settings.allowed_staff_emails:
        allowed = {e.strip().lower() for e in settings.allowed_staff_emails.split(",") if e.strip()}
        if email_lower in allowed:
            return True
    if settings.allowed_staff_domain:
        domain = settings.allowed_staff_domain.strip().lower()
        if domain and email_lower.endswith(f"@{domain}"):
            return True
    return False


def _verify_token_sync(token: str) -> dict:
    return id_token.verify_oauth2_token(
        token, google_requests.Request(), audience=settings.google_oauth_client_id
    )


async def require_staff_user(authorization: str = Header(default="")) -> StaffUser:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="ต้องเข้าสู่ระบบก่อนใช้งาน")
    token = authorization[len("Bearer "):].strip()
    if not token:
        raise HTTPException(status_code=401, detail="ต้องเข้าสู่ระบบก่อนใช้งาน")

    if not settings.google_oauth_client_id:
        raise HTTPException(status_code=500, detail="เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID")

    try:
        claims = await asyncio.to_thread(_verify_token_sync, token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="เข้าสู่ระบบไม่สำเร็จ กรุณา sign in ใหม่อีกครั้ง") from exc

    email = claims.get("email", "")
    if not claims.get("email_verified") or not email:
        raise HTTPException(status_code=401, detail="อีเมล Google ยังไม่ได้ยืนยัน")
    if not _is_allowed_email(email):
        raise HTTPException(status_code=403, detail=f"อีเมล {email} ไม่ได้รับอนุญาตให้ใช้งานระบบนี้")

    return StaffUser(email=email, name=claims.get("name") or email)
