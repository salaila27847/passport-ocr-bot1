import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    google_service_account_json: str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    main_folder_name: str = os.environ.get("MAIN_FOLDER_NAME", "interview")
    typhoon_api_key: str = os.environ.get("TYPHOON_API_KEY", "")
    typhoon_base_url: str = os.environ.get("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")


settings = Settings()
