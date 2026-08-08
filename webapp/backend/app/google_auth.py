import json
from functools import lru_cache

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials as UserCredentials
from googleapiclient.discovery import build

from app.config import settings

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
DRIVE_ONLY_SCOPES = ["https://www.googleapis.com/auth/drive"]


def _load_credentials() -> service_account.Credentials:
    if not settings.google_service_account_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
    info = json.loads(settings.google_service_account_json)
    return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)


def _load_drive_credentials():
    """Service accounts have no Drive storage quota of their own, so files they create fail
    with 403 storageQuotaExceeded unless the target folder lives in a Shared Drive (webapp/README.md,
    Phase 5 findings). When a delegated user's refresh token is configured, upload as that real
    Google account instead so files count against its quota; otherwise fall back to the service
    account (fine for Sheets and for Drive reads, but uploads will still fail until configured)."""
    if settings.google_drive_refresh_token:
        return UserCredentials(
            None,
            refresh_token=settings.google_drive_refresh_token,
            client_id=settings.google_drive_oauth_client_id,
            client_secret=settings.google_drive_oauth_client_secret,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=DRIVE_ONLY_SCOPES,
        )
    return _load_credentials()


@lru_cache
def get_sheets_service():
    return build("sheets", "v4", credentials=_load_credentials(), cache_discovery=False)


@lru_cache
def get_drive_service():
    return build("drive", "v3", credentials=_load_drive_credentials(), cache_discovery=False)
