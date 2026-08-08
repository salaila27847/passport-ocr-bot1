"""
รัน backend จริงทั้งชุด (FastAPI routing + Pydantic validation/serialization + auth middleware)
แต่สลับ Google Sheets/Drive เป็นข้อมูลจำลองในหน่วยความจำ (app/testkit) และ bypass การตรวจ
Google ID token จริง (เพราะยังไม่มี OAuth Client ID/บัญชี Google ทดสอบในสภาพแวดล้อมนี้)

ใช้สำหรับทดสอบว่า frontend คุยกับ backend "จริง" ถูกต้อง (ไม่ใช่ทดสอบกับ response ที่ frontend
สมมติเอาเองแบบที่ทำใน Playwright ตอน Phase 4) — เป็นก้าวกลางระหว่างนั้นกับการทดสอบกับ
Google Sheets/Drive/OAuth ของจริงใน Phase 5

**ห้ามใช้ในโปรดักชัน** — ไม่มีการตรวจสิทธิ์จริงเลย

รัน: python scripts/run_demo_server.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn

from app import drive, sheets
from app.auth import StaffUser, require_staff_user
from app.main import app
from app.testkit.fake_drive import FakeDriveService
from app.testkit.fake_sheets import FakeSheetsService

DEMO_SHEET_NAME = "ทริปสาธิต (Demo)"


def _seed_sheets() -> FakeSheetsService:
    grid = {
        "SUMMARY": {
            1: {1: "SEQ", 2: "วันที่จอง", 3: "Flight", 4: "สัญชาติ", 5: "จอง/เลขพาสปอร์ต", 6: "ชื่อ"},
            2: {1: "1"},  # ว่าง จองได้
            3: {1: "2", 5: "จองโดย Demo User"},  # จองแล้ว ยังไม่กรอกข้อมูล
            4: {  # กรอกข้อมูลเพิ่มเติมสมบูรณ์แล้ว (E ถูกเขียนทับเป็นเลขพาสปอร์ต)
                1: "3", 4: "THA", 5: "AA1234567", 6: "SOMYING SOMSRI",
                7: "กลุ่ม A", 8: "กลุ่ม 1", 9: "", 10: 1, 11: "V1", 12: "", 13: "", 14: "", 15: "",
            },
        },
        "PHOTO": {
            1: {1: "SEQ"},
            2: {1: "1"},
            3: {1: "2"},
            4: {1: "3"},
        },
        "OCR_RESULTS": {
            1: {c: h for c, h in enumerate(sheets.OCR_RESULTS_HEADERS, start=1)},
            2: {
                1: "3", 2: "08/08/2026 10:00:00", 3: "done", 4: "THA", 5: "AA1234567", 6: "F",
                7: "SOMYING SOMSRI", 8: "SOMYING SOMSRI", 9: "", 10: "pending", 11: "",
            },
        },
        "GROUP": {
            1: {1: "กลุ่มเดิม", 2: "กลุ่มใหม่"},
            2: {1: "กลุ่ม A", 2: "กลุ่ม 1"},
            3: {1: "กลุ่ม B", 2: "กลุ่ม 2"},
        },
        "VISA": {
            1: {13: "VISA"},
            2: {13: "V1"},
            3: {13: "V2"},
        },
        "CLAUSE": {
            1: {1: "CLAUSE"},
            2: {1: "C1"},
            3: {1: "C2"},
        },
    }
    return FakeSheetsService(grid)


def _seed_drive() -> FakeDriveService:
    fake = FakeDriveService()
    root = fake.add_folder("interview")
    fake.add_sheet(DEMO_SHEET_NAME, root, "2026-08-08T10:00:00Z")
    return fake


def main() -> None:
    fake_sheets_service = _seed_sheets()
    fake_drive_service = _seed_drive()

    sheets.get_sheets_service = lambda: fake_sheets_service
    drive.get_drive_service = lambda: fake_drive_service

    demo_staff = StaffUser(email="demo@example.com", name="เจ้าหน้าที่สาธิต")
    app.dependency_overrides[require_staff_user] = lambda: demo_staff

    print(f"Demo backend: sheet '{DEMO_SHEET_NAME}' seeded with SEQ 1 (ว่าง), 2 (จองแล้ว), 3 (ข้อมูลครบ + ผล OCR)")
    print("Auth bypassed — ทุก request ถือเป็นเจ้าหน้าที่สาธิตอัตโนมัติ ห้ามใช้โหมดนี้ใน production")
    uvicorn.run(app, host="0.0.0.0", port=8080)


if __name__ == "__main__":
    main()
