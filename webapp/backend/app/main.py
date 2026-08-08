from fastapi import FastAPI

from app.config import settings

app = FastAPI(title="Passport Check-in Backend")


@app.get("/healthz")
def healthz():
    return {
        "status": "ok",
        "google_service_account_configured": bool(settings.google_service_account_json),
        "typhoon_configured": bool(settings.typhoon_api_key),
    }
