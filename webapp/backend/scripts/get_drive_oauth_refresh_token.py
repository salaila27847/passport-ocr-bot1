"""
รันสคริปต์นี้ครั้งเดียวบนเครื่องของคุณเอง (ไม่ใช่ใน container/sandbox — ต้องมีเบราว์เซอร์จริงและ
ล็อกอินด้วยบัญชี Google ที่เป็นเจ้าของโฟลเดอร์ `interview` จริง เช่น hktimmarr4@gmail.com) เพื่อขอ
refresh token ให้ backend อัปโหลดรูปเข้า Drive แทน service account (ซึ่งไม่มีโควตาพื้นที่ของตัวเอง —
ดู webapp/README.md หัวข้อ Phase 5 ว่าทำไมต้องมีขั้นตอนนี้)

ก่อนรัน:
1. ติดตั้ง dependency เพิ่ม (ตัวเดียว ไม่ได้อยู่ใน requirements.txt เพราะใช้แค่สคริปต์นี้สคริปต์เดียว):
     pip install google-auth-oauthlib
2. ตั้งค่า OAuth consent screen ให้เสร็จก่อน (ถ้ายังไม่เคยทำ) ที่ Google Cloud Console > APIs & Services >
   OAuth consent screen: User Type = External, กรอกชื่อแอป/อีเมลติดต่อ แล้วเพิ่มอีเมลเจ้าของโฟลเดอร์
   `interview` เป็น "Test user" ไว้ด้วย (ไม่งั้นล็อกอินไม่ผ่านเพราะแอปยังไม่ผ่านการ verify จาก Google)
3. สร้าง OAuth Client ID ชนิด "Desktop app" ที่ APIs & Services > Credentials > Create Credentials >
   OAuth client ID > Application type: Desktop app (คนละตัวกับ Client ID ที่ใช้ทำ Google Sign-In ใน
   frontend ซึ่งเป็นชนิด Web application — Desktop app เท่านั้นที่ขอ refresh token แบบไม่มี fixed
   redirect URI ได้สะดวก) ดาวน์โหลดไฟล์ JSON ที่ได้

รัน:
     python scripts/get_drive_oauth_refresh_token.py /path/to/downloaded_client_secret.json

จะเปิดเบราว์เซอร์ให้ล็อกอิน + กด Allow ด้วยบัญชีเจ้าของโฟลเดอร์ `interview` (จะเจอหน้าเตือน "Google
hasn't verified this app" เพราะแอปยังไม่ได้ผ่าน verify — กด Advanced > Go to <ชื่อแอป> (unsafe) ได้ปกติ
เพราะเป็นแอปที่คุณสร้างเอง) แล้วพิมพ์ค่าที่ได้ 3 ตัว (GOOGLE_DRIVE_OAUTH_CLIENT_ID,
GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN) ลงใน .env

สำคัญ — กัน token หมดอายุใน 7 วัน: ตราบใดที่ OAuth consent screen ยังอยู่สถานะ "Testing" (ค่าเริ่มต้น)
refresh token ที่ได้จะหมดอายุใน 7 วัน ก่อนใช้งานจริงให้ไปที่ OAuth consent screen แล้วกด "PUBLISH APP"
เปลี่ยนสถานะเป็น "In production" (ไม่ต้องผ่านกระบวนการ verify ของ Google ก็กดได้ แค่ยังมีหน้าเตือน
"unverified app" ตอนล็อกอินเหมือนเดิม ซึ่งไม่กระทบอะไรเพราะสคริปต์นี้รันครั้งเดียว) — เปลี่ยนแล้ว
refresh token จะไม่หมดอายุแบบนั้นอีก
"""
import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive"]


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} /path/to/downloaded_client_secret.json", file=sys.stderr)
        sys.exit(1)

    client_secret_path = sys.argv[1]
    flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, scopes=SCOPES)
    creds = flow.run_local_server(port=0)

    with open(client_secret_path) as f:
        client_info = json.load(f)
    client_id = client_info.get("installed", client_info.get("web", {})).get("client_id", "")

    print("\nสำเร็จ! ใส่ค่าต่อไปนี้ลงใน webapp/backend/.env:\n")
    print(f"GOOGLE_DRIVE_OAUTH_CLIENT_ID={client_id}")
    print(f"GOOGLE_DRIVE_OAUTH_CLIENT_SECRET={creds.client_secret}")
    print(f"GOOGLE_DRIVE_REFRESH_TOKEN={creds.refresh_token}")


if __name__ == "__main__":
    main()
