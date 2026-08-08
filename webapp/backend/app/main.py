from fastapi import FastAPI

from app.config import settings

app = FastAPI(title="Passport Check-in Backend")


@app.get("/healthz")
def healthz():
    return {
        "status": "ok",
        "sheet_configured": bool(settings.sheet_id),
        "drive_configured": bool(settings.drive_folder_id),
        "typhoon_configured": bool(settings.typhoon_api_key),
    }
