# ระบบเช็คอินใหม่ (แทน LINE bot + Google Apps Script)

สถานะ: **Phase 0 — โครงโปรเจกต์เท่านั้น** ยังไม่มี business logic ระบบเก่า (`app.py` + `Code.gs` ที่ root ของรีโป) ยังใช้งานได้ตามปกติจนกว่าจะ cutover (ดู Phase 6)

## สถาปัตยกรรม

```
เบราว์เซอร์ (webapp/frontend, PWA)
        │ HTTPS
        ▼
webapp/backend (FastAPI, Python) ── Google Sheets API ──► Google Sheet เดิม (SUMMARY/OCR_RESULTS/GROUP/VISA/CLAUSE)
        │                        └─ Google Drive API ──► โฟลเดอร์รูปเดิม
        └─ Typhoon OCR API (opentyphoon.ai) — เสริม OCR (passport bio page cross-check + Return Ticket/Accommodation field extraction)
```

Google Sheets/Drive ยังเป็นฐานข้อมูลหลักเหมือนเดิม (ไม่ย้ายไป Postgres) เพราะฝ่ายอื่นยังต้องดูรายงานจาก Sheet และไม่มีงบสำหรับ hosting แบบเสียเงิน แผน deploy backend คือ Google Cloud Run free tier (cold start เร็วกว่า Render free tier มาก และ auth กับ Sheets/Drive อยู่ระบบนิเวศเดียวกัน)

## โครงสร้างโฟลเดอร์

- `backend/` — FastAPI service (จะรวม OCR pipeline จาก `app.py` เดิมเข้ามาใน Phase 3)
- `frontend/` — PWA แบบ static file (ยังไม่มี build tool ใน Phase 0 เพื่อลดความซับซ้อน/ความเสี่ยงเรื่อง dependency — ถ้าจำเป็นค่อยเพิ่ม bundler ใน Phase 4)

## รันทดสอบในเครื่อง (local dev)

**Backend:**
```bash
cd webapp/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8080
curl http://localhost:8080/healthz
```

**Frontend:** (เปิดคู่กับ backend ด้านบน)
```bash
cd webapp/frontend
python3 -m http.server 8090
# เปิด http://localhost:8090
```

## สิ่งที่ต้องตั้งค่าเอง (ทำนอกรีโปนี้ — ต้องใช้สิทธิ์ Google Cloud/Google Workspace ของคุณ)

รายการนี้เป็นขั้นตอนที่ผมทำแทนไม่ได้ เพราะต้องใช้บัญชี Google Cloud ของคุณเอง ทำตามลำดับก่อนเริ่ม Phase 1:

1. **สร้าง Google Cloud Project** (หรือใช้โปรเจกต์เดิมถ้ามี) ที่ [console.cloud.google.com](https://console.cloud.google.com)
2. เปิดใช้งาน **Google Sheets API** และ **Google Drive API** ใน APIs & Services
3. สร้าง **Service Account** (IAM & Admin > Service Accounts) แล้วดาวน์โหลดคีย์เป็นไฟล์ JSON
4. เปิด Google Sheet ที่ใช้งานจริง (ตัวที่มีแท็บ SUMMARY/OCR_RESULTS/GROUP/VISA/CLAUSE) แล้วกด **Share** ให้กับอีเมลของ service account (อยู่ในไฟล์ JSON ที่ดาวน์โหลดมา ช่อง `client_email`) สิทธิ์ระดับ Editor
5. แชร์โฟลเดอร์ Drive ที่เก็บรูป (โฟลเดอร์ `interview` เดิม) ให้ service account เดียวกัน สิทธิ์ Editor เช่นกัน
6. สมัคร API key ของ Typhoon OCR ที่ [opentyphoon.ai](https://opentyphoon.ai) — เก็บ key ไว้ใส่ env var
7. คัดลอก `backend/.env.example` เป็น `.env` แล้วกรอกค่า: `SHEET_ID` (เอาจาก URL ของ Google Sheet), `GOOGLE_SERVICE_ACCOUNT_JSON` (path หรือเนื้อหาไฟล์ JSON จากข้อ 3), `DRIVE_FOLDER_ID`, `TYPHOON_API_KEY`

## Deploy ขึ้น Google Cloud Run (ทำตอนเริ่มมี logic จริงแล้ว ไม่ต้องรีบทำใน Phase 0)

```bash
gcloud run deploy passport-checkin-backend \
  --source webapp/backend \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars SHEET_ID=...,DRIVE_FOLDER_ID=...,TYPHOON_API_KEY=...
```

## แผนเป็นเฟส

| เฟส | สถานะ | รายละเอียด |
|---|---|---|
| 0 — Setup & Foundations | ✅ เสร็จ | โครง backend/frontend, health check ใช้งานได้ |
| 1 — Data layer | ⏳ ถัดไป | โมดูล Sheets/Drive API แทน `SpreadsheetApp`/`DriveApp` |
| 2 — Backend core REST API | รอ | port state machine จาก `Code.gs` |
| 3 — OCR pipeline + Typhoon | รอ | ย้าย `app.py` เข้ามา + เพิ่ม Typhoon OCR |
| 4 — Frontend PWA | รอ | หน้าจอเจ้าหน้าที่จริง |
| 5 — Integration test | รอ | ทดสอบกับ Sheet สำเนา |
| 6 — Cutover | รอ | ปิด LINE bot + GAS |
