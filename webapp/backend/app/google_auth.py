import json
from functools import lru_cache

from google.oauth2 import service_account
from googleapiclient.discovery import build

from app.config import settings

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def _load_credentials() -> service_account.Credentials:
    if not settings.google_service_account_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
    info = json.loads(settings.google_service_account_json)
    return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)


@lru_cache
def get_sheets_service():
    return build("sheets", "v4", credentials=_load_credentials(), cache_discovery=False)


@lru_cache
def get_drive_service():
    return build("drive", "v3", credentials=_load_credentials(), cache_discovery=False)
