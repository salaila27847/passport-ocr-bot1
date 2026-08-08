from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router as api_router
from app.config import settings

app = FastAPI(title="Passport Check-in Backend")

# frontend เป็น static site แยก origin กับ backend (เช่น deploy คนละที่) — เปิด CORS ให้เรียกข้ามได้
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/healthz")
def healthz():
    return {
        "status": "ok",
        "google_service_account_configured": bool(settings.google_service_account_json),
        "typhoon_configured": bool(settings.typhoon_api_key),
        "google_oauth_configured": bool(settings.google_oauth_client_id),
    }


@app.get("/config")
def public_config():
    """ค่าที่ frontend ต้องรู้ก่อน sign in ได้ (ไม่ลับ) — ไม่อยู่หลัง auth เพราะยังไม่มี token ตอนนี้"""
    return {"google_client_id": settings.google_oauth_client_id}
