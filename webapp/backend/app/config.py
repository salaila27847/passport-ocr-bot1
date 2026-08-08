import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    google_service_account_json: str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    main_folder_name: str = os.environ.get("MAIN_FOLDER_NAME", "interview")
    typhoon_api_key: str = os.environ.get("TYPHOON_API_KEY", "")
    typhoon_base_url: str = os.environ.get("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")
    # ยืนยันตัวตนเจ้าหน้าที่ด้วย Google Sign-In (Google Identity Services) แทน LINE userId เดิม
    google_oauth_client_id: str = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    # อนุญาตแบบเจาะจงอีเมล (คั่นด้วย comma) และ/หรือทั้งโดเมน Google Workspace — ไม่ตั้งค่าเลย = ปฏิเสธทุกคน (fail closed)
    allowed_staff_emails: str = os.environ.get("ALLOWED_STAFF_EMAILS", "")
    allowed_staff_domain: str = os.environ.get("ALLOWED_STAFF_DOMAIN", "")


settings = Settings()
