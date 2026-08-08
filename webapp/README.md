# ระบบเช็คอินใหม่ (แทน LINE bot + Google Apps Script)

สถานะ: **Phase 5 ทดสอบกับ credential จริงแล้ว (Sheets/Drive อ่าน-เขียนจริงผ่าน, auth verification จริงผ่าน) — เจอบั๊กจริง 1 ตัวและแก้ในโค้ดแล้ว (อัปโหลดรูปด้วย service account ใช้ไม่ได้ เปลี่ยนไปอัปโหลดด้วย OAuth ของเจ้าของโฟลเดอร์แทน) แต่ยังใช้อัปโหลดรูปจริงไม่ได้จนกว่าคุณจะรัน `scripts/get_drive_oauth_refresh_token.py` ขอ refresh token ครั้งเดียว (ต้องมีเบราว์เซอร์ ทำแทนจาก sandbox ไม่ได้) และมี 2 เรื่องที่ยัง verify ไม่ได้จาก session นี้ (Typhoon OCR ถูก network policy ของ sandbox บล็อก, Google Sign-In แบบ interactive ในเบราว์เซอร์จริงต้องให้คุณทดสอบเอง) — ดูหัวข้อ "Phase 5 ทดสอบกับ credential จริง" ด้านล่าง** ระบบเก่า (`app.py` + `Code.gs` ที่ root ของรีโป) ยังใช้งานได้ตามปกติจนกว่าจะ cutover (ดู Phase 6)

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
- `backend/app/testkit/` — fake Sheets/Drive API แบบ in-memory (ย้ายมาจาก `tests/` ตอน Phase 5 เพราะมีคนใช้ 2 ที่แล้ว: pytest suite และ `scripts/run_demo_server.py`) ไม่ใช้ในโค้ด production เลย
- `backend/scripts/run_demo_server.py` — รัน backend **จริงทั้งชุด** (FastAPI routing/Pydantic/auth) แต่สลับ Sheets/Drive เป็นข้อมูลจำลอง + bypass การตรวจ Google token จริง สำหรับเดโม/ทดสอบ frontend-backend integration โดยไม่ต้องมี Google credential (ดูหัวข้อ Demo mode ด้านล่าง) — **ห้ามใช้ใน production**
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

### Demo mode (Phase 5) — รัน frontend คุยกับ backend จริงโดยไม่ต้องมี Google credential

```bash
cd webapp/backend
.venv/bin/pip install -r requirements.txt
GOOGLE_OAUTH_CLIENT_ID=demo .venv/bin/python scripts/run_demo_server.py
```
รันคู่กับ `python3 -m http.server 8090` ใน `webapp/frontend/` ตามปกติ เปิด `http://localhost:8090` ได้เลย — ปุ่ม Google Sign-In จะยังเป็นปุ่มจริงจาก Google (เพราะ script โหลดจาก `accounts.google.com` ตรงๆ) กด sign-in จริงไม่ได้เพราะ `GOOGLE_OAUTH_CLIENT_ID=demo` ไม่ใช่ client ID จริง — โหมดนี้มีไว้ทดสอบด้วย Playwright ที่ mock เฉพาะ Google Identity Services script (ดูหัวข้อ Playwright integration test ด้านล่าง) ไม่ใช่ไว้กดใช้เองในเบราว์เซอร์ตรงๆ

ข้อมูลจำลองใน `run_demo_server.py`: SEQ 1 (ว่าง, จองได้), SEQ 2 (จองแล้ว, ยังไม่กรอกข้อมูล), SEQ 3 (กรอกข้อมูลครบ + มีผล OCR ให้ทดสอบปุ่ม "นำเข้าข้อมูล OCR")

**ทดสอบแล้วผ่านทั้งหมดด้วยวิธีนี้ (Playwright, ยิง frontend จริงชนกับ backend จริง ไม่ mock response เอง):**
sign-in → โหลดรายชื่อ Sheet จริงจาก backend → จอง SEQ (auto-extend logic จริง) → เปิดฟอร์มข้อมูลเพิ่มเติม SEQ 3 เห็นข้อมูลที่ seed ไว้จริง → กด "นำเข้าข้อมูล OCR" ได้ค่าจาก OCR_RESULTS จริง → แก้ไข NOTE แล้วบันทึก → reload หน้าเว็บใหม่ เห็นค่าที่บันทึกไว้จริง (ยืนยันว่าเขียนลง fake Sheet จริง ไม่ใช่แค่ state ฝั่ง browser) → อัปโหลดรูปพาสปอร์ตจริงผ่าน multipart form ไปยัง SEQ 2 → รูป preview ขึ้นจริง → reload แล้วรูปยังอยู่ → background OCR job (PassportEye จริง + Typhoon client จริงที่ fallback เพราะไม่มี API key) รันจบโดยไม่ทำให้ server ล่ม

### Phase 5 ทดสอบกับ credential จริง (session ที่มี env var ให้แล้ว)

ทดสอบตรงกับ `app.drive`/`app.sheets`/`app.ocr.typhoon_client`/`app.auth` (import โมดูลจริง เรียกจริง ไม่ผ่าน mock/fake ใดๆ) โดยใช้ `GOOGLE_SERVICE_ACCOUNT_JSON`/`TYPHOON_API_KEY`/`GOOGLE_OAUTH_CLIENT_ID`/`ALLOWED_STAFF_*` ที่มีอยู่ใน environment variable ของ session แล้ว ไม่ต้องรอสร้างใหม่

**ผ่านหมด (อ่าน+เขียน Sheets/Drive จริง):**
- `list_available_sheets()` เจอ Google Sheet จริง 10 ไฟล์ในโฟลเดอร์ `interview` ตามชื่อโฟลเดอร์ที่ตั้งไว้ — ยืนยันว่า service account credential + share สิทธิ์ถูกต้อง
- อ่าน dropdown (GROUP/VISA/CLAUSE) จากชีตจริงได้ค่าจริง
- เจอชีตชื่อ `testing1` ที่ดูเหมือนเป็นชีตสำหรับทดสอบ (ยืนยันกับคุณก่อนแล้วว่าใช้ทดสอบ write ได้) — ทดสอบ `book_seqs()` (จอง SEQ ใหม่จริง, เห็นวันที่+ข้อความจองเขียนลง SUMMARY จริง), `write_ocr_result()` (เขียนแถว OCR_RESULTS จริง, อ่านกลับมาตรงกับที่เขียน) ผ่านทั้งคู่ — **ทดสอบเสร็จแล้วล้างข้อมูลทดสอบออกจากชีตเรียบร้อย** (เคลียร์ booking กลับเป็นว่าง, ลบแถว OCR_RESULTS ที่สร้างไว้)

**เจอบั๊กจริง 1 ตัว — แก้แล้วในโค้ด รอขั้นตอนที่ต้องทำเองอีก 1 ครั้ง ก่อนจะใช้งานได้จริง:**
- `drive.upload_photo()` ยิงจริงแล้วได้ `403 storageQuotaExceeded`: *"Service Accounts do not have storage quota. Leverage shared drives... or use OAuth delegation instead."* — **service account ไม่มีพื้นที่เก็บไฟล์ของตัวเอง** การแชร์โฟลเดอร์ `interview` ให้ service account เป็น Editor พอสำหรับอ่าน/เขียน Sheets และสร้างโฟลเดอร์ย่อยได้ (ไม่กินพื้นที่) แต่**อัปโหลดไฟล์จริงไม่ได้เด็ดขาด**เพราะไฟล์ที่ service account สร้างจะถูกนับเป็นพื้นที่ของ service account เอง ไม่ใช่ของโฟลเดอร์/เจ้าของ — ระบบเดิม (`Code.gs`) ไม่เจอปัญหานี้เพราะรันในบริบทบัญชี Google Workspace ของคนจริงที่มีโควตาเอง ไม่ใช่ service account
  - เช็คแล้วว่าโฟลเดอร์ `interview` เป็นของ**บัญชี Gmail ส่วนตัว** (`drives().list()` ไม่เจอ Shared Drive เลย) จึงตัด **Shared Drive** และ **domain-wide delegation** ออก — ทั้งสองทางต้องมี Google Workspace ซึ่งบัญชีนี้ไม่มี
  - **ทางแก้ที่ใช้: อัปโหลดด้วย OAuth ของบัญชีจริงที่เป็นเจ้าของโฟลเดอร์แทน service account** — แก้แล้วใน `app/google_auth.py` (`get_drive_service()` ใช้ credential จาก refresh token ที่ตั้งค่าไว้แทน service account โดยอัตโนมัติเมื่อมีการตั้งค่า ไม่ต้องแก้ `drive.py` เลยเพราะทุกจุดเรียกผ่าน `get_drive_service()` เดิมอยู่แล้ว, ไม่ตั้งค่า = fallback ไปใช้ service account เหมือนเดิมทุกจุด ไม่กระทบ demo mode/unit test ที่ mock `get_drive_service()` ตรงๆ อยู่แล้ว) — เพิ่มสคริปต์ `scripts/get_drive_oauth_refresh_token.py` ให้รันครั้งเดียวบนเครื่องคุณเอง (ต้องมีเบราว์เซอร์ ทำแทนจาก sandbox ไม่ได้ เพราะต้องล็อกอินจริง) ดูขั้นตอนเต็มในหัวข้อ "สิ่งที่ต้องตั้งค่าเอง" ข้อ 8 ด้านล่าง — 97 unit test เดิมยังผ่านหมดหลังแก้ (ไม่มีอะไรพังเพราะ mock function เดิมไว้ตรงจุดเดิม)
  - **✅ Verify กับ Drive จริงแล้ว**: คุณรันสคริปต์ขอ refresh token สำเร็จ (สร้าง OAuth Client ID ชนิด Desktop app, เพิ่ม test user, ได้ token จริง) — ทดสอบตั้งค่า 3 ตัวนี้แล้วอัปโหลดไฟล์เข้าโฟลเดอร์รูปของ `testing1` จริงผ่าน `drive.upload_photo()` สำเร็จ ไม่เจอ `403 storageQuotaExceeded` อีกต่อไป (ลบไฟล์ทดสอบออกจาก Drive เรียบร้อยหลังยืนยัน) — เหลือแค่ใส่ค่าทั้ง 3 ตัวลง `.env`/Cloud Run ของ production จริงตามหัวข้อ "สิ่งที่ต้องตั้งค่าเอง" ข้อ 8-9 และอย่าลืมกด **Publish App** ที่หน้า Audience กันไม่ให้ token หมดอายุใน 7 วัน

**ยัง verify ไม่ได้จาก session นี้ (ไม่ใช่บั๊ก แต่เป็นข้อจำกัดของ sandbox):**
- **Typhoon OCR**: เรียก `extract_passport_name()` จริงแล้วโดน sandbox proxy ตอบ `403` ที่ปลายทาง `api.opentyphoon.ai` — เช็คแล้วว่าเป็น org egress policy ของ session นี้ที่ไม่ได้ allowlist โดเมนนี้ไว้ (ยืนยันจาก proxy status endpoint ว่าเป็น `connect_rejected`/policy denial ไม่ใช่ auth หรือโค้ดผิด) ส่วน Google Sheets/Drive API (`googleapis.com`) ผ่าน sandbox ได้ปกติ — ต้องทดสอบ Typhoon จริงอีกทีตอน deploy ขึ้น Cloud Run หรือรันจากเครื่อง/เครือข่ายที่ไม่ถูกบล็อก
- **Google Sign-In แบบ interactive จริง**: ยืนยันได้แค่ "ท่อประปา" ถูกต้อง — `GET /config` คืน `google_client_id` จริง, endpoint ที่ต้อง auth ปฏิเสธ request ไม่มี token/token ปลอมถูกต้อง (401) ด้วย `id_token.verify_oauth2_token` ตัวจริงที่เรียก Google cert endpoint จริง (ไม่ใช่ mock) — แต่การกด "Sign in with Google" จริงในเบราว์เซอร์ต้องมีมนุษย์ล็อกอินบัญชี Google จริงๆ ซึ่ง session นี้ทำแทนไม่ได้ (ไม่มีเบราว์เซอร์แบบ interactive/ไม่มีบัญชีให้ล็อกอิน) — ทดสอบเองตามขั้นตอนใน "รันทดสอบในเครื่อง" ด้านล่าง หรือถ้าอยากให้ agent ทดสอบ `GET /me` ต่อให้ครบ ส่ง ID token จริง (อายุสั้น ๆ จากการ sign-in ครั้งหนึ่ง) มาให้ทดสอบเพิ่มได้

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
ทดสอบในเครื่องโดยไม่มี Google OAuth Client ID จริงได้จำกัด — หน้า sign-in จะขึ้น error "ยังไม่ได้ตั้งค่า Google Sign-In" จนกว่าจะตั้ง `GOOGLE_OAUTH_CLIENT_ID` (ใช้ `scripts/run_demo_server.py` แทน `uvicorn` ตรงๆ ถ้าอยากลองกดใช้ทั้งระบบโดยไม่ต้องมี Google credential จริง — ดูหัวข้อ Demo mode ด้านบน)

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
8. **ขอ refresh token ให้อัปโหลดรูปเข้า Drive ได้** (จำเป็น ไม่ทำข้อนี้ = อัปโหลดรูปพัง — ดูหัวข้อ Phase 5 ด้านบนว่าทำไม): service account ไม่มีโควตาพื้นที่ Drive ของตัวเอง และโฟลเดอร์ `interview` เป็นของบัญชี Gmail ส่วนตัว (ไม่ใช่ Google Workspace) จึงใช้ Shared Drive หรือ domain-wide delegation ไม่ได้ ต้องอัปโหลดแทนด้วยบัญชีจริงที่เป็นเจ้าของโฟลเดอร์:
   - ถ้ายังไม่เคยตั้ง OAuth consent screen ของโปรเจกต์นี้: ไปที่ APIs & Services > OAuth consent screen > User Type = External > กรอกชื่อแอป/อีเมล > ในหน้า "Test users" เพิ่มอีเมลเจ้าของโฟลเดอร์ `interview` ไว้ด้วย (ไม่งั้น login ไม่ผ่านเพราะแอปยังไม่ verify)
   - สร้าง OAuth Client ID อีกตัว ชนิด **Desktop app** (คนละตัวกับข้อ 6 ที่เป็น Web application) ที่ APIs & Services > Credentials > Create Credentials > OAuth client ID > Desktop app แล้วดาวน์โหลดไฟล์ JSON
   - รันบนเครื่องตัวเอง (ต้องมีเบราว์เซอร์ ทำแทนไม่ได้จาก sandbox): `pip install google-auth-oauthlib` แล้ว `python webapp/backend/scripts/get_drive_oauth_refresh_token.py /path/to/downloaded_client_secret.json` — ล็อกอินด้วยบัญชีที่เป็นเจ้าของโฟลเดอร์ `interview` จริง จะเจอหน้าเตือน "Google hasn't verified this app" ให้กด Advanced > Go to (unsafe) แล้ว Allow จะได้ค่า `GOOGLE_DRIVE_OAUTH_CLIENT_ID`/`GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`/`GOOGLE_DRIVE_REFRESH_TOKEN` มาใส่ `.env`
   - **ก่อนใช้งานจริง**: กลับไปที่ OAuth consent screen แล้วกด **Publish App** เปลี่ยนสถานะจาก "Testing" เป็น "In production" — ถ้าปล่อยเป็น Testing ไว้ refresh token ที่ได้จะหมดอายุใน 7 วัน (กด Publish ไม่ต้องผ่าน verify ของ Google ก็ได้ แค่ยังมีหน้าเตือน unverified ตอน login เหมือนเดิม ไม่กระทบอะไรเพราะสคริปต์นี้รันครั้งเดียว)
9. คัดลอก `backend/.env.example` เป็น `.env` (ไฟล์ต้องชื่อ `.env` เป๊ะๆ — แก้ `.env.example` ตรงๆ จะไม่ถูกอ่าน) แล้วกรอกค่า: `GOOGLE_SERVICE_ACCOUNT_JSON` (เนื้อหาไฟล์ JSON จากข้อ 3, เป็น JSON string ทั้งก้อน), `MAIN_FOLDER_NAME` (ปกติคือ `interview`), `TYPHOON_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID` (จากข้อ 6), `ALLOWED_STAFF_DOMAIN`/`ALLOWED_STAFF_EMAILS` (จากข้อ 7), `GOOGLE_DRIVE_OAUTH_CLIENT_ID`/`GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`/`GOOGLE_DRIVE_REFRESH_TOKEN` (จากข้อ 8) — `app/config.py` โหลด `.env` เข้า `os.environ` อัตโนมัติผ่าน `python-dotenv` ตอน import (ไม่ทับ env var จริงที่ตั้งไว้แล้ว เช่นตอน deploy) ไม่ต้อง `source`/`export` เอง

## Deploy ขึ้น Google Cloud Run (Phase 6)

ทำบนเครื่องที่มี `gcloud` login เข้าโปรเจกต์จริงแล้วเท่านั้น (sandbox/CI ทำแทนไม่ได้ ไม่มีสิทธิ์เข้าถึง GCP project ของคุณ) ก่อน deploy ครั้งแรกให้เปิดใช้ API ที่จำเป็นก่อน:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

### 1. สร้าง secret ใน Secret Manager (ครั้งแรกครั้งเดียว)

ค่า 3 ตัวนี้เป็นความลับ ห้ามใส่เป็น `--set-env-vars` ตรงๆ (จะโชว์เป็น plain text ใน Cloud Run console/audit log) — ดึงจาก `.env` แล้วส่งเข้า Secret Manager ตรงๆ กัน quoting พังจาก `private_key` ที่มี newline:

```bash
cd webapp/backend
python3 -c "from dotenv import dotenv_values; print(dotenv_values('.env')['GOOGLE_SERVICE_ACCOUNT_JSON'], end='')" \
  | gcloud secrets create google-service-account --data-file=-
python3 -c "from dotenv import dotenv_values; print(dotenv_values('.env')['GOOGLE_DRIVE_OAUTH_CLIENT_SECRET'], end='')" \
  | gcloud secrets create drive-oauth-client-secret --data-file=-
python3 -c "from dotenv import dotenv_values; print(dotenv_values('.env')['GOOGLE_DRIVE_REFRESH_TOKEN'], end='')" \
  | gcloud secrets create drive-oauth-refresh-token --data-file=-
```

(deploy ครั้งต่อๆ ไปถ้าค่าเปลี่ยน ใช้ `gcloud secrets versions add <name> --data-file=-` แทน `create`)

### 2. Deploy backend

```bash
gcloud run deploy passport-checkin-backend \
  --source webapp/backend \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars MAIN_FOLDER_NAME=interview,TYPHOON_API_KEY=...,GOOGLE_OAUTH_CLIENT_ID=...,ALLOWED_STAFF_DOMAIN=...,GOOGLE_DRIVE_OAUTH_CLIENT_ID=... \
  --set-secrets GOOGLE_SERVICE_ACCOUNT_JSON=google-service-account:latest,GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=drive-oauth-client-secret:latest,GOOGLE_DRIVE_REFRESH_TOKEN=drive-oauth-refresh-token:latest
```

`--allow-unauthenticated` แปลว่า URL เข้าถึงได้จากอินเทอร์เน็ตทั่วไป (ปกติสำหรับ Cloud Run ที่ auth ทำเองในแอป) — ระบบมี auth ของตัวเองอยู่แล้วผ่าน Google Sign-In + `ALLOWED_STAFF_DOMAIN`/`ALLOWED_STAFF_EMAILS` (fail closed ถ้าไม่ตั้งค่า) เก็บ URL ที่ได้จาก output (`https://passport-checkin-backend-xxxxx.run.app`) ไว้ใช้ขั้นต่อไป

ทดสอบว่า deploy ผ่านจริง: `curl https://<URL ที่ได้>/health` ควรได้ 200

### 3. Deploy frontend

frontend เป็น static files ล้วน deploy แยกจาก backend ได้เลย (เช่น Render Static Site, Cloudflare Pages, หรือแม้แต่ Cloud Storage bucket — ฟรีทุกตัว) ต้องแก้ `BACKEND_URL` ใน `frontend/app.js` (หรือประกาศ `window.BACKEND_URL` ใน `index.html` ก่อนโหลด `app.js`) ให้ชี้ไป URL ของ backend จาก ข้อ 2

### 4. เพิ่ม origin ของ frontend ที่ deploy จริงเข้า OAuth Client (ข้อ 6 ในหัวข้อ "สิ่งที่ต้องตั้งค่าเอง")

กลับไปที่ Google Cloud Console > APIs & Services > Credentials > OAuth client ID ตัวที่เป็น Web application (Google Sign-In) แล้วเพิ่ม URL จริงของ frontend เข้า "Authorized JavaScript origins" — ไม่งั้น Google Sign-In จะ error ตอนล็อกอินจาก URL จริง (ผ่านเฉพาะตอน dev ที่ `localhost`)

### 5. ทดสอบ end-to-end บน URL จริงก่อนปิดระบบเก่า

ล็อกอินจริงผ่านเบราว์เซอร์ (Google Sign-In), เลือกชีตทดสอบ `testing1`, ลองจอง SEQ, ถ่ายรูป OCR จริงผ่าน Typhoon, อัปโหลดรูปจริง — ครบทุกจุดที่ sandbox ทดสอบแทนไม่ได้ ผ่านหมดค่อยพิจารณาขั้นปิด LINE bot + GAS (Code.gs)

## แผนเป็นเฟส

| เฟส | สถานะ | รายละเอียด |
|---|---|---|
| 0 — Setup & Foundations | ✅ เสร็จ | โครง backend/frontend, health check ใช้งานได้ |
| 1 — Data layer | ✅ เสร็จ | โมดูล Sheets/Drive API แทน `SpreadsheetApp`/`DriveApp`, 28 unit test ผ่าน |
| 2 — Backend core REST API | ✅ เสร็จ | 8 endpoints, 49 unit test ผ่านรวม (เพิ่ม 21 เคสของ Phase นี้) |
| 3 — OCR pipeline + Typhoon | ✅ เสร็จ | ย้าย `app.py` เข้ามา (ตัด regex ออก) + เพิ่ม Typhoon OCR, 84 unit test ผ่านรวม |
| 4 — Frontend PWA | ✅ เสร็จ | Google Sign-In auth (ใหม่ทั้งฝั่ง backend/frontend) + หน้าจอเจ้าหน้าที่ครบ (เลือก Sheet/จอง SEQ/รูปภาพ/ข้อมูลเพิ่มเติม), 97 unit test + Playwright E2E ผ่านหมด (mock ทั้ง Google Sign-In และ backend เพราะยังไม่มี credential จริง) |
| 5 — Integration test | 🔶 ทดสอบกับ credential จริงแล้ว เจอบั๊กจริง 1 ตัวและแก้+verify แล้ว | ทดสอบ Sheets/Drive จริงทั้งอ่าน+เขียน (list sheets, dropdown, book SEQ, เขียน OCR_RESULTS) ผ่านหมดกับชีตทดสอบ `testing1` — **เจอบั๊กจริง**: อัปโหลดรูปด้วย service account ใช้ไม่ได้ (`403 storageQuotaExceeded`, service account ไม่มีโควตาพื้นที่ของตัวเอง, โฟลเดอร์เป็นของ Gmail ส่วนตัวใช้ Shared Drive/domain delegation ไม่ได้) — **แก้แล้วและ verify กับ Drive จริงแล้ว**: `get_drive_service()` อัปโหลดผ่าน OAuth ของเจ้าของโฟลเดอร์แทนเมื่อตั้งค่า `GOOGLE_DRIVE_REFRESH_TOKEN` ไว้ — คุณรัน `scripts/get_drive_oauth_refresh_token.py` ขอ refresh token จริงแล้ว ทดสอบอัปโหลดไฟล์เข้าโฟลเดอร์รูปของ `testing1` จริงสำเร็จ ไม่เจอ `storageQuotaExceeded` อีก (ลบไฟล์ทดสอบออกแล้ว) — เหลือแค่ตั้งค่า 3 ตัวนี้ใน `.env`/Cloud Run ของ production จริง (97 unit test ผ่านหมด) — auth verification จริง (`id_token.verify_oauth2_token` เรียก Google cert endpoint จริง) ผ่าน แต่ยังไม่ได้ทดสอบ interactive sign-in จริงในเบราว์เซอร์ (ต้องมีมนุษย์ล็อกอิน) — Typhoon OCR ยิงจริงจาก session นี้ไม่ได้เพราะ sandbox network policy บล็อก `api.opentyphoon.ai` (ต้องทดสอบตอน deploy จริงหรือจากเครือข่ายที่ไม่ถูกบล็อก) |
| 6 — Cutover | 🔶 เริ่มแล้ว | deploy backend/frontend ขึ้นจริง + ทดสอบ end-to-end บน URL จริง (Google Sign-In/Typhoon OCR ที่ sandbox ทดสอบแทนไม่ได้) ก่อนค่อยปิด LINE bot + GAS เป็นขั้นสุดท้าย — ดูหัวข้อ "Deploy ขึ้น Google Cloud Run" ด้านบน |
