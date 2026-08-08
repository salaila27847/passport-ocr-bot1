# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Migration in progress

`app.py` + `Code.gs` (LINE bot + GAS) are being replaced by a new system in `webapp/` (FastAPI backend +
PWA frontend, Google Sheets/Drive kept as the data store, Typhoon OCR added alongside passporteye). See
`webapp/README.md` for architecture and phase status. Until Phase 6 (cutover) is done, **`app.py` and
`Code.gs` are still the live production system** — keep them working, don't remove anything from them as
part of building `webapp/`.

## What this is

A two-part system for OCR-ing passport MRZ data during an event check-in workflow, driven from a LINE chat bot:

- **`app.py`** — Flask OCR microservice (Python), deployed to Render, wraps `passporteye`/Tesseract.
- **`Code.gs`** — Google Apps Script Web App. It *is* the LINE bot (webhook handler), and it also owns all
  Google Sheets/Drive state — there is no separate database.
- **`readme.md`** — a very long, detailed Thai-language build log covering every bug fixed and feature added,
  including full copies of `app.py`/`Code.gs`/`Dockerfile` source and a changelog table. Treat it as the
  authoritative design history; when in doubt about *why* something in `Code.gs` or `app.py` is shaped a
  certain way, search `readme.md` for the function name before guessing. There is no `Dockerfile` checked
  into this directory — its contents only exist inside `readme.md`.

There is no build system, package.json, or test suite in this repo — it's two source files deployed by hand
to two different platforms.

## Running / deploying

There is no local dev server for `Code.gs` — it only runs inside the Google Apps Script editor/Web App
deployment. To change bot behavior:
1. Edit `Code.gs` directly.
2. Copy-paste the full file contents into the Apps Script project (Apps Script has no git integration here).
3. **Deploy > Manage deployments > edit the active deployment > Version: New version > Deploy.** Saving alone
   does not update the live webhook — this is a recurring source of "why isn't my change live" confusion.

For `app.py` (Render):
```bash
pip install -r requirements.txt
python app.py   # local run, but passporteye/Tesseract must be installed on the host — see readme.md's Dockerfile section
```
Render deploys automatically from a `git push` (or manual deploy in the dashboard). There's no linter/test
command configured — verify changes by hitting the endpoints directly, e.g.:
```bash
curl -X POST -F "image=@sample.jpg" http://localhost:5000/ocr
```

Required Render environment variables: `APPS_SCRIPT_WEBHOOK_URL` (Apps Script `/exec` URL),
`APPS_SCRIPT_TOKEN` (must equal `SECRET_TOKEN` in `Code.gs`), optional `MIN_ACCEPTABLE_SCORE` (default `70`).

Secrets in `Code.gs` (`CHANNEL_ACCESS_TOKEN`, `SECRET_TOKEN`, `RENDER_OCR_URL`/`RENDER_OCR_SUBMIT_URL`) are
plain constants at the top of the file — Apps Script has no env var mechanism here, so updating a token means
editing the constant and redeploying.

## Architecture: background OCR pipeline

OCR is asynchronous end-to-end so a cold Render instance (free tier, 30-50s cold start) never blocks the LINE
bot's reply. Google Sheets doubles as the results queue (tab `OCR_RESULTS`, auto-created):

```
LINE photo → Code.gs submitPassportOcrAsync() → POST /ocr/submit (fire-and-forget)
    → Code.gs replies immediately + "📥 นำเข้าข้อมูล" button
    → app.py spawns a background thread, runs run_ocr_pipeline()
    → app.py POSTs the result back to Code.gs doPost() as {action: "ocr_callback"}
    → handleOcrCallback() writes/overwrites the OCR_RESULTS row for that SEQ
Staff taps "นำเข้าข้อมูล" → importOcrResult() looks up the row by SEQ:
    not found/still queued → "please wait"; if queued longer than OCR_TIMEOUT_MS (60s) → report error instead
    status=error → ask to retake photo
    status=done  → write into SUMMARY tab, strike through the OCR_RESULTS row, mark ImportStatus=imported
```
Re-photographing the same SEQ overwrites its `OCR_RESULTS` row rather than creating a duplicate.
`app.py`'s synchronous `/ocr` and `/ocr/passport` routes still exist for direct testing but are no longer
called from `Code.gs`.

## `app.py` internals worth knowing

- Two independent name extractions run in parallel and both are surfaced to staff to choose between:
  `clean_name_field()`/PassportEye's parsed fields, vs `parse_mrz_line1_regex()` regex-parsing MRZ line 1
  directly. This exists because PassportEye/Tesseract can inject junk tokens (repeated-letter runs like
  `KKKKK`, or consonant-only strings) into names — `is_noise_token()` filters those out.
- `run_ocr_pipeline()` retries once against a contrast/sharpen/upscale-enhanced image
  (`enhance_image()`) if the first MRZ read scores below `MIN_ACCEPTABLE_SCORE`, keeping whichever read
  scores higher.
- `nationality_mismatch` is computed by comparing the issuing-country code against the nationality field
  parsed from MRZ line 2; a mismatch sets a `remark` string that `Code.gs` surfaces as a highlighted warning.
- `process_ocr_job_background()` retries the callback POST to Apps Script up to 4 times with backoff
  `[2, 4, 8]`s; a permanent failure is only logged (Render logs), not otherwise recovered.

## `Code.gs` internals worth knowing

`Code.gs` is one big file organized by `// ====` banner comments (grep for them to navigate): config/consts,
debug logging, concurrency, `doPost` webhook entry, `handleEvent` (the conversation state machine), image
handling/classification, the pending-photo queue, OCR + SUMMARY logic, cached SEQ→row lookups, and generic
helpers at the bottom.

- **Conversation state is per-user, stored in `PropertiesService.getUserProperties()`** as string flags keyed
  like `{userId}_sheetId`, `{userId}_seq`, `{userId}_awaitingSeq`, `{userId}_awaitingBookingCount`,
  `{userId}_pendingFlightSeqs`. `handleEvent()` is essentially a manual state machine that checks these flags
  in sequence — when adding a new step that prompts for text input, remember to set the corresponding
  `_awaiting*` flag *before* sending the prompt, or the next text message will fall through to the
  "ไม่เข้าใจข้อความ" (unrecognized) fallback (this exact bug happened once for the Flight No. step; see
  readme.md changelog entry 3).
- **Photos are queued per-SEQ, not classified immediately on receipt.** Images land in
  `_pendingQueue_{seq}` (via `getPendingQueue`/`savePendingQueue`) so a burst of photos doesn't spam Flex
  messages; staff explicitly taps "🗂️ จัดการรูป" (`handleManagePhotos`) to classify them one at a time.
- **Concurrency:** any read-modify-write against the Sheet (SEQ booking, OCR_RESULTS writes, ETC photo column
  assignment, flight no. updates) is wrapped in `withLock()` (`LockService`, 10s wait + one 5s retry) because
  multiple staff can act on the same sheet concurrently.
- **SEQ→row lookups are cached** via `CacheService` (`buildSeqRowMap`/`findRowBySeqCached`,
  `invalidateSeqRowCache`, 5-minute TTL) instead of scanning the sheet on every call — invalidate the cache
  after any structural change to the row range (e.g. after auto-extending SUMMARY).
- **Uploaded photo filenames** encode `{SEQ}_{TYPE}_{SHEETNAME}.jpg` (or `{SEQ}_ETC_{SHEETNAME}_{N}.jpg` for
  multiple ETC files) so multiple sheets sharing one Drive folder don't collide.
- LINE Flex Message layout only supports `vertical`/`horizontal`/`baseline` — **not** `grid`; using `grid`
  silently produces a 400 from the LINE API that the original code swallowed. `sendLineReply` now checks the
  response code and throws, with `pushMessages`/`pushText` as fallbacks when a reply token is already spent.
- Debug logs go to a **Google Sheet named `BOT_DEBUG_LOG`** (tab `LOG`), created automatically — use it as
  the primary place to check "what happened" instead of the Apps Script Executions panel.
- `cleanupPendingFiles()` deletes `_PENDING_`-prefixed Drive files older than 24h; it only runs via a
  time-driven trigger set up once by manually running `setupCleanupTrigger()` in the Apps Script editor after
  each fresh deployment/copy of the project.
