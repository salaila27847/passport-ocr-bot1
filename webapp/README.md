# ระบบเช็คอินใหม่ (แทน LINE bot + Google Apps Script)

สถานะ: **Phase 4 เสร็จแล้ว (Frontend PWA)** ระบบเก่า (`app.py` + `Code.gs` ที่ root ของรีโป) ยังใช้งานได้ตามปกติจนกว่าจะ cutover (ดู Phase 6)

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

- `backend/app/main.py` — FastAPI entrypoint (`/healthz` + mounts `api.router`)
- `backend/app/config.py` — env-based config
- `backend/app/google_auth.py` — สร้าง Sheets/Drive API client จาก service account
- `backend/app/locking.py` — `AsyncKeyedLock` ล็อกเฉพาะ key (ต่อแถว/ต่อ SEQ) แทน `LockService` ของ GAS ที่ล็อกทั้งสคริปต์
- `backend/app/sheets.py` — Sheets API: SEQ→row cache (5 นาที, พอร์ตจาก `findRowBySeqCached`), อ่าน/เขียน SUMMARY (ข้อมูลเพิ่มเติม), อ่าน dropdown, จอง SEQ (พร้อม auto-extend แถว), อัปเดต Flight No., อ่าน/เขียน OCR_RESULTS, เขียนคอลัมน์รูปในแท็บ PHOTO
- `backend/app/drive.py` — Drive API: รายชื่อ Google Sheet ที่เลือกได้ (พอร์ตจาก `findAllSheetsRecursive`), โฟลเดอร์รูปตามชื่อ, อัปโหลด/ค้นหา/ลบไฟล์
- `backend/app/api.py` — REST endpoints (พอร์ตจาก `handleEvent`/`doPost` ฝั่ง business logic — ดูตารางด้านล่าง)
- `backend/app/schemas.py` — Pydantic request/response models
- `backend/app/ocr/passporteye_client.py` — พอร์ตจาก `app.py` เดิม (passporteye/Tesseract, retry ด้วย enhanced image, `clean_name_field`/`is_noise_token`) **ตัด `parse_mrz_line1_regex()` ออก** — ไม่ใช้ regex เป็นแหล่งชื่อคู่แข่งอีกต่อไป
- `backend/app/ocr/typhoon_client.py` — เรียก Typhoon OCR (OpenAI-compatible API) ด้วย prompt ที่เขียนเอง (ไม่ใช้ `ocr_document()` ของแพ็กเกจ `typhoon-ocr` เพราะ prompt ของมันผูกไว้สำหรับแปลงทั้งหน้าเป็น markdown ทั่วไป ที่นี่ต้องการ field เจาะจงเป็น JSON) — ดึงชื่อจากหน้าพาสปอร์ต / เลขไฟลต์จากตั๋ว / ชื่อโรงแรมจากใบจองที่พัก, error ทุกแบบ (ไม่ตั้ง API key, เรียก API ไม่สำเร็จ) รวมเป็น `TyphoonOcrError` เดียวให้ caller จับง่าย
- `backend/app/ocr/pipeline.py` — งานพื้นหลังหลังอัปโหลดรูป (เรียกผ่าน FastAPI `BackgroundTasks`): รูป PASSPORT รัน PassportEye + Typhoon พร้อมกันแล้วเขียน OCR_RESULTS, รูป Return Ticket ลองดึง Flight No. อัตโนมัติด้วย Typhoon
- `backend/app/auth.py` — ยืนยันตัวตนด้วย Google Sign-In (ดูหัวข้อ Auth ด้านล่าง) แทน LINE userId เดิม
- `backend/tests/` — unit test ครบทุกโมดูลข้างต้น (97 เคส) ใช้ fake Sheets/Drive API แบบ in-memory + FastAPI `TestClient` + mock ของ `passporteye.read_mrz`/OpenAI client/`id_token.verify_oauth2_token` เพราะยังไม่มี credential จริง/tesseract binary ให้ทดสอบตรงๆ — รันด้วย `pytest`
- `frontend/` — PWA แบบ static file ล้วน ไม่มี build tool (ES modules ที่เบราว์เซอร์รองรับเองอยู่แล้ว):
  - `index.html` — shell, โหลด Google Identity Services script
  - `app.js` — bootstrap + hash-based router (`#/sheets`, `#/seq`, `#/seq/{seq}`, `#/seq/{seq}/photos`, `#/seq/{seq}/extra-info`)
  - `js/api.js` — fetch wrapper ที่แนบ `Authorization: Bearer <id_token>` ให้ทุก request อัตโนมัติ
  - `js/auth.js` — เรียก Google Identity Services (`google.accounts.id`)
  - `js/views.js` — หน้าจอทั้งหมด: sign-in, เลือก Sheet, dashboard (เลือก/จอง SEQ), จัดการรูปภาพ, ฟอร์มข้อมูลเพิ่มเติม
  - `icons/` — ไอคอน PWA (generate ด้วย Pillow ไว้ในสคริปต์ ไม่ใช่ของจริงจาก design — เปลี่ยนเป็นโลโก้จริงได้ทีหลัง)
  - `sw.js` — cache static shell (ไม่ cache การเรียก backend เพราะข้อมูล SEQ/รูป/OCR เปลี่ยนได้ตลอด)

### OCR pipeline (Phase 3)

รูป PASSPORT ที่อัปโหลดจะรัน 2 แหล่งพร้อมกัน (ไม่บล็อกการตอบกลับ HTTP ของการอัปโหลด):
- **PassportEye** อ่าน MRZ (checksum-validated) — แหล่งหลัก ถ้าอ่านไม่ได้เลย = OCR error
- **Typhoon OCR** อ่านชื่อจากหน้าไบโอเมตริกที่พิมพ์ไว้ (ไม่ใช่ MRZ) — แหล่งเสริมให้เจ้าหน้าที่เทียบ ถ้า Typhoon ล่ม/ไม่ได้ตั้ง API key ก็ไปต่อด้วยผล PassportEye อย่างเดียว ไม่ทำให้ทั้ง pipeline ล้ม

**ตัด regex ออกจากการเทียบชื่อโดยตั้งใจ** — เหลือแค่ PassportEye กับ Typhoon สองแหล่ง (คอลัมน์ `OCR_RESULTS` เดิมชื่อ `RegexName` เปลี่ยนเป็น `TyphoonName`)

รูป Return Ticket จะลองดึง Flight No. อัตโนมัติด้วย Typhoon แล้วเติมคอลัมน์ Flight No. ของ SEQ นั้นให้ (เจ้าหน้าที่ยังแก้ไข/กรอกเองได้ตามปกติถ้าอ่านไม่ได้) — ส่วนรูป Accomodation ยังไม่ trigger OCR อัตโนมัติเพราะ SUMMARY sheet ไม่มีคอลัมน์ปลายทางสำหรับชื่อโรงแรม/วันที่เช็คอิน ต้องตัดสินใจเรื่อง schema ก่อนถึงจะเขียนอัตโนมัติได้ (ฟังก์ชันดึงข้อมูล `extract_accommodation_fields()` เตรียมไว้แล้วใน `typhoon_client.py` รอแค่จุดเขียนลงชีต)

### Auth (Phase 4)

ทุก endpoint ใน `api.router` อยู่หลัง `require_staff_user` dependency: frontend ได้ ID token จาก Google Sign-In (Google Identity Services) มาแนบเป็น `Authorization: Bearer <token>` ทุก request แล้ว backend ตรวจสอบ token กับ Google (`google.oauth2.id_token.verify_oauth2_token`) จากนั้นเช็คอีเมลกับ allowlist (`ALLOWED_STAFF_EMAILS` และ/หรือ `ALLOWED_STAFF_DOMAIN`) — **ไม่ตั้งค่า allowlist เลย = ปฏิเสธทุกคน (fail closed)** ต้องตั้งอย่างน้อย 1 ตัว

`POST /sheets/{id}/bookings` เปลี่ยนจากรับ `user_name` จาก client (spoof ได้) เป็นใช้ชื่อจากตัวตนที่ auth แล้วแทน — endpoint ใหม่ `GET /me` ให้ frontend เช็คว่า token ยังใช้ได้และแสดงชื่อผู้ใช้ปัจจุบัน

`GET /config` เป็น endpoint เดียวที่ **ไม่** อยู่หลัง auth (ตั้งใจ) เพราะ frontend ต้องรู้ `google_client_id` ก่อนจะ sign in ได้

### REST API (Phase 2-4)

| Endpoint | พอร์ตจาก (Code.gs) | หมายเหตุ |
|---|---|---|
| `GET /config` | — | ไม่ต้อง auth, คืน `google_client_id` ให้ frontend เริ่ม sign-in flow |
| `GET /me` | — | เช็คตัวตนปัจจุบัน (ใหม่ใน Phase 4) |
| `GET /sheets` | `sendSheetFlexMenu` | รายชื่อ Sheet ให้เลือก |
| `GET /sheets/{id}/dropdowns` | `getColumnValuesForDropdown` ×4 | GROUP/VISA/CLAUSE |
| `POST /sheets/{id}/bookings` | `processBookingInSummarySheet` + `updateFlightNoInSummarySheet` | รวม 2 ขั้นตอนแชทเดิมเป็น request เดียว, `user_name` มาจาก auth ไม่ใช่ client |
| `GET/PUT /sheets/{id}/seq/{seq}/extra-info` | `renderExtraInfoPage` / `handleSaveSummaryExtra` | |
| `GET /sheets/{id}/seq/{seq}/ocr-preview` | `handleFetchOcrPreview` | |
| `POST/GET /sheets/{id}/seq/{seq}/photos`, `/photo` | `classifyAndSavePhoto` / `getPassportPhotoUrl` | อัปโหลดรูป PASSPORT/Return Ticket จะ trigger OCR background job (ดูหัวข้อ OCR pipeline ด้านบน) |

**ตัดออกไปโดยตั้งใจจาก state machine เดิม:** ทั้ง `_awaitingSeq`/`_awaitingBookingCount`/`_pendingQueue_*` (per-user flags ใน `PropertiesService`) ไม่จำเป็นอีกต่อไป เพราะ frontend เป็นฟอร์มเว็บที่ส่ง `sheet_id`/`seq` มาตรงๆ ทุก request แทนการเดาขั้นตอนจากข้อความแชท ส่วนรายการ "SEQ ที่จองไว้แต่ยังไม่จบงาน" ต่อพนักงาน (`BOOKED_{sheetId}_{userName}` ใน Script Properties) ยังไม่พอร์ตมา — พึ่งพา in-memory state ข้าม request ไม่เข้ากับ Cloud Run ที่ scale เป็นหลาย instance ได้ ต้องหาที่เก็บถาวรกว่านี้ถ้าจะทำ ตอนนี้ข้ามไปก่อนเพราะเป็นแค่ตัวช่วยเตือน ไม่ใช่ข้อมูลหลัก

**หมายเหตุสำคัญ:** ระบบเดิมให้เจ้าหน้าที่ **เลือกได้ว่าจะทำงานกับ Google Sheet ไฟล์ไหน** (มีหลายไฟล์ในโฟลเดอร์ `interview`, หนึ่งไฟล์ต่อกลุ่ม/งาน) ไม่ได้ผูกกับ Sheet เดียวตายตัว — ดังนั้น `sheet_id` เป็นพารามิเตอร์ที่ทุกฟังก์ชันใน `sheets.py`/`drive.py` รับเข้ามาต่อ request ไม่ใช่ค่า config ตายตัว (`list_available_sheets()` ใน `drive.py` คือจุดที่หา Sheet ทั้งหมดให้เลือก)

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
ทดสอบในเครื่องโดยไม่มี Google OAuth Client ID จริงได้จำกัด — หน้า sign-in จะขึ้น error "ยังไม่ได้ตั้งค่า Google Sign-In" จนกว่าจะตั้ง `GOOGLE_OAUTH_CLIENT_ID` ในฝั่ง backend (ดูขั้นตอนด้านล่าง) ระหว่างพัฒนา ผมทดสอบ flow ทั้งหมด (sign-in → เลือก Sheet → จอง SEQ → อัปโหลดรูป → กรอกฟอร์ม → นำเข้า OCR → บันทึก) ด้วย Playwright โดย mock ทั้ง Google Identity Services script และ response จาก backend endpoint ทุกตัว ยืนยันว่า UI/state ทำงานถูกต้องแล้ว แต่ **ยังไม่เคยทดสอบกับ Google Sign-In จริงหรือ backend ที่มี credential จริง** เป็นงานของ Phase 5

**รัน test (ไม่ต้องมี Google credential จริง เพราะใช้ fake Sheets/Drive API + mock token verification):**
```bash
cd webapp/backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -v
```

## สิ่งที่ต้องตั้งค่าเอง (ทำนอกรีโปนี้ — ต้องใช้สิทธิ์ Google Cloud/Google Workspace ของคุณ)

รายการนี้เป็นขั้นตอนที่ผมทำแทนไม่ได้ เพราะต้องใช้บัญชี Google Cloud ของคุณเอง ทำก่อนจะทดสอบกับ Sheet จริงและ sign-in จริง (ตอนนี้ยังทดสอบผ่าน fake API ได้โดยไม่ต้องมีสิ่งเหล่านี้):

1. **สร้าง Google Cloud Project** (หรือใช้โปรเจกต์เดิมถ้ามี) ที่ [console.cloud.google.com](https://console.cloud.google.com)
2. เปิดใช้งาน **Google Sheets API** และ **Google Drive API** ใน APIs & Services
3. สร้าง **Service Account** (IAM & Admin > Service Accounts) แล้วดาวน์โหลดคีย์เป็นไฟล์ JSON
4. เปิดโฟลเดอร์ Drive ชื่อ `interview` (โฟลเดอร์หลักที่มีทั้ง Google Sheet ทุกไฟล์และรูปที่เก็บอยู่) แล้วกด **Share** ให้กับอีเมลของ service account (อยู่ในไฟล์ JSON ที่ดาวน์โหลดมา ช่อง `client_email`) สิทธิ์ระดับ Editor — แชร์ที่ตัวโฟลเดอร์แม่ก็พอ ครอบคลุมทุกไฟล์ข้างในอัตโนมัติ
5. สมัคร API key ของ Typhoon OCR ที่ [opentyphoon.ai](https://opentyphoon.ai) — เก็บ key ไว้ใส่ env var
6. **สร้าง OAuth Client ID สำหรับ Google Sign-In** (ต่างจาก service account ข้อ 3 — อันนี้ไว้ให้เจ้าหน้าที่ login ผ่านเบราว์เซอร์): ไปที่ APIs & Services > Credentials > Create Credentials > OAuth client ID > เลือก "Web application" > ใส่ URL ของ frontend ทั้งใน "Authorized JavaScript origins" (เช่น `https://your-frontend.example.com`) และตอน dev ใส่ `http://localhost:8090` เพิ่มด้วย > ได้ Client ID มา (ไม่ใช่ secret ใส่ตรงๆ ใน frontend ได้) — ครั้งแรกต้องตั้งค่า OAuth consent screen ก่อนด้วย (เลือก Internal ถ้าเป็น Google Workspace องค์กรเดียวกัน จะได้จำกัดเฉพาะคนในโดเมนอัตโนมัติ)
7. ตัดสินใจว่าใครเข้าระบบได้: ตั้ง `ALLOWED_STAFF_DOMAIN` (ถ้าทุกคนอยู่โดเมน Google Workspace เดียวกัน) และ/หรือ `ALLOWED_STAFF_EMAILS` (คั่นด้วย comma สำหรับอีเมลเฉพาะเจาะจง เช่น gmail.com ส่วนตัว) — **ไม่ตั้งเลยจะปฏิเสธทุกคน**
8. คัดลอก `backend/.env.example` เป็น `.env` แล้วกรอกค่า: `GOOGLE_SERVICE_ACCOUNT_JSON` (เนื้อหาไฟล์ JSON จากข้อ 3, เป็น JSON string ทั้งก้อน), `MAIN_FOLDER_NAME` (ปกติคือ `interview`), `TYPHOON_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID` (จากข้อ 6), `ALLOWED_STAFF_DOMAIN`/`ALLOWED_STAFF_EMAILS` (จากข้อ 7)

## Deploy ขึ้น Google Cloud Run (ทำตอนเริ่มมี logic จริงแล้ว ไม่ต้องรีบทำตอนนี้)

```bash
gcloud run deploy passport-checkin-backend \
  --source webapp/backend \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars MAIN_FOLDER_NAME=interview,TYPHOON_API_KEY=...,GOOGLE_OAUTH_CLIENT_ID=...,ALLOWED_STAFF_DOMAIN=... \
  --set-secrets GOOGLE_SERVICE_ACCOUNT_JSON=google-service-account:latest
```

frontend เป็น static files ล้วน deploy แยกจาก backend ได้เลย (เช่น Render Static Site, Cloudflare Pages, หรือแม้แต่ Cloud Storage bucket — ฟรีทุกตัว) ต้องแก้ `BACKEND_URL` ใน `frontend/app.js` (หรือประกาศ `window.BACKEND_URL` ใน `index.html` ก่อนโหลด `app.js`) ให้ชี้ไป URL ของ backend จริงหลัง deploy

## แผนเป็นเฟส

| เฟส | สถานะ | รายละเอียด |
|---|---|---|
| 0 — Setup & Foundations | ✅ เสร็จ | โครง backend/frontend, health check ใช้งานได้ |
| 1 — Data layer | ✅ เสร็จ | โมดูล Sheets/Drive API แทน `SpreadsheetApp`/`DriveApp`, 28 unit test ผ่าน |
| 2 — Backend core REST API | ✅ เสร็จ | 8 endpoints, 49 unit test ผ่านรวม (เพิ่ม 21 เคสของ Phase นี้) |
| 3 — OCR pipeline + Typhoon | ✅ เสร็จ | ย้าย `app.py` เข้ามา (ตัด regex ออก) + เพิ่ม Typhoon OCR, 84 unit test ผ่านรวม |
| 4 — Frontend PWA | ✅ เสร็จ | Google Sign-In auth (ใหม่ทั้งฝั่ง backend/frontend) + หน้าจอเจ้าหน้าที่ครบ (เลือก Sheet/จอง SEQ/รูปภาพ/ข้อมูลเพิ่มเติม), 97 unit test + Playwright E2E ผ่านหมด (mock ทั้ง Google Sign-In และ backend เพราะยังไม่มี credential จริง) |
| 5 — Integration test | ⏳ ถัดไป | ทดสอบกับ Sheet สำเนา + Google Sign-In จริง + credential จริงทั้งหมด |
| 6 — Cutover | รอ | ปิด LINE bot + GAS |
