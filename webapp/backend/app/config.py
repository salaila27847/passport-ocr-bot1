import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    sheet_id: str = os.environ.get("SHEET_ID", "")
    google_service_account_json: str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    drive_folder_id: str = os.environ.get("DRIVE_FOLDER_ID", "")
    typhoon_api_key: str = os.environ.get("TYPHOON_API_KEY", "")
    typhoon_base_url: str = os.environ.get("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")


settings = Settings()
