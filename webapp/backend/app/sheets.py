import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from googleapiclient.errors import HttpError

from app.google_auth import get_sheets_service
from app.locking import AsyncKeyedLock

# TTL เดียวกับ CacheService ที่ findRowBySeqCached() ใช้ใน Code.gs เดิม (5 นาที)
ROW_CACHE_TTL_SECONDS = 300

BANGKOK_TZ = timezone(timedelta(hours=7))

_row_cache: dict[tuple[str, str], tuple[dict[str, int], float]] = {}
sheet_locks = AsyncKeyedLock()


async def _execute(request) -> dict:
    return await asyncio.to_thread(request.execute)


async def _values_get(sheet_id: str, range_: str) -> dict:
    service = get_sheets_service()
    return await _execute(service.spreadsheets().values().get(spreadsheetId=sheet_id, range=range_))


async def _batch_update_values(sheet_id: str, data: list[dict]) -> None:
    if not data:
        return
    service = get_sheets_service()
    body = {"valueInputOption": "USER_ENTERED", "data": data}
    await _execute(service.spreadsheets().values().batchUpdate(spreadsheetId=sheet_id, body=body))


async def _batch_update(sheet_id: str, requests: list[dict]) -> None:
    service = get_sheets_service()
    await _execute(service.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body={"requests": requests}))


async def _get_sheet_properties(sheet_id: str) -> list[dict]:
    service = get_sheets_service()
    result = await _execute(service.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties"))
    return [s["properties"] for s in result.get("sheets", [])]


async def get_tab_gid(sheet_id: str, tab_name: str) -> int:
    for props in await _get_sheet_properties(sheet_id):
        if props.get("title") == tab_name:
            return props["sheetId"]
    raise ValueError(f'ไม่พบแท็บ "{tab_name}"')


# ==========================================
# CACHED SEQ -> ROW INDEX (พอร์ตจาก buildSeqRowMap/findRowBySeqCached/invalidateSeqRowCache)
# ==========================================
async def _build_row_map(sheet_id: str, tab_name: str) -> dict[str, int]:
    values = await _values_get(sheet_id, f"{tab_name}!A:A")
    rows = values.get("values", [])
    row_map: dict[str, int] = {}
    for i, row in enumerate(rows[1:], start=2):  # แถวที่ 1 = header, ข้ามไป
        seq = str(row[0]).strip() if row else ""
        if seq:
            row_map[seq] = i
    return row_map


async def _get_row_map(sheet_id: str, tab_name: str) -> dict[str, int]:
    key = (sheet_id, tab_name)
    cached = _row_cache.get(key)
    now = time.monotonic()
    if cached and cached[1] > now:
        return cached[0]
    row_map = await _build_row_map(sheet_id, tab_name)
    _row_cache[key] = (row_map, now + ROW_CACHE_TTL_SECONDS)
    return row_map


async def find_row_by_seq(sheet_id: str, tab_name: str, seq: str) -> int | None:
    row_map = await _get_row_map(sheet_id, tab_name)
    return row_map.get(str(seq).strip())


def invalidate_row_cache(sheet_id: str, tab_name: str) -> None:
    _row_cache.pop((sheet_id, tab_name), None)


# ==========================================
# DROPDOWN COLUMNS (พอร์ตจาก getColumnValuesForDropdown)
# ==========================================
async def get_column_values_for_dropdown(sheet_id: str, tab_name: str, column_letter: str) -> list[str]:
    try:
        values = await _values_get(sheet_id, f"{tab_name}!{column_letter}:{column_letter}")
    except HttpError:
        return []
    rows = values.get("values", [])
    seen: list[str] = []
    seen_set: set[str] = set()
    for row in rows:
        v = str(row[0]).strip() if row else ""
        if v and v not in seen_set:
            seen_set.add(v)
            seen.append(v)
    return seen


# ==========================================
# SUMMARY — ข้อมูลเพิ่มเติม (พอร์ตจาก renderExtraInfoPage/handleSaveSummaryExtra)
# ==========================================
@dataclass
class SummaryExtra:
    nationality: str = ""
    passport_no: str = ""
    name: str = ""
    sex_m: bool = False
    sex_f: bool = False
    group_old: str = ""
    group_new: str = ""
    visa_now: str = ""
    visa_ex: str = ""
    deport: bool = False
    clauses: str = ""
    note: str = ""


async def read_summary_extra(sheet_id: str, seq: str) -> SummaryExtra | None:
    row = await find_row_by_seq(sheet_id, "SUMMARY", seq)
    if row is None:
        return None
    values = await _values_get(sheet_id, f"SUMMARY!D{row}:O{row}")
    cells = (values.get("values") or [[]])
    cells = cells[0] if cells else []
    cells = cells + [""] * (12 - len(cells))
    return SummaryExtra(
        nationality=str(cells[0] or ""),
        passport_no=str(cells[1] or ""),
        name=str(cells[2] or ""),
        group_old=str(cells[3] or ""),
        group_new=str(cells[4] or ""),
        sex_m=bool(cells[5]),
        sex_f=bool(cells[6]),
        visa_now=str(cells[7] or ""),
        visa_ex=str(cells[8] or ""),
        deport=bool(cells[9]),
        clauses=str(cells[10] or ""),
        note=str(cells[11] or ""),
    )


async def write_summary_extra(sheet_id: str, seq: str, fields: SummaryExtra) -> bool:
    row = await find_row_by_seq(sheet_id, "SUMMARY", seq)
    if row is None:
        return False
    data = []
    if fields.nationality:
        data.append({"range": f"SUMMARY!D{row}", "values": [[fields.nationality]]})
    if fields.passport_no:
        data.append({"range": f"SUMMARY!E{row}", "values": [[fields.passport_no]]})
    if fields.name:
        data.append({"range": f"SUMMARY!F{row}", "values": [[fields.name]]})
    if fields.sex_m:
        data.append({"range": f"SUMMARY!I{row}:J{row}", "values": [[1, ""]]})
    elif fields.sex_f:
        data.append({"range": f"SUMMARY!I{row}:J{row}", "values": [["", 1]]})
    data.append({"range": f"SUMMARY!G{row}", "values": [[fields.group_old]]})
    data.append({"range": f"SUMMARY!H{row}", "values": [[fields.group_new]]})
    data.append({"range": f"SUMMARY!K{row}", "values": [[fields.visa_now]]})
    data.append({"range": f"SUMMARY!L{row}", "values": [[fields.visa_ex]]})
    data.append({"range": f"SUMMARY!M{row}", "values": [[1 if fields.deport else ""]]})
    data.append({"range": f"SUMMARY!N{row}", "values": [[fields.clauses]]})
    data.append({"range": f"SUMMARY!O{row}", "values": [[fields.note]]})

    async with sheet_locks.acquire(f"{sheet_id}:SUMMARY:{row}"):
        await _batch_update_values(sheet_id, data)
    return True


def has_ocr_edits(fields: SummaryExtra) -> bool:
    return bool(fields.nationality or fields.passport_no or fields.name or fields.sex_m or fields.sex_f)


# ==========================================
# SEQ BOOKING (พอร์ตจาก processBookingInSummarySheet)
# ==========================================
async def _get_last_row(sheet_id: str, tab_name: str) -> int:
    values = await _values_get(sheet_id, f"{tab_name}!A:A")
    return len(values.get("values", []))


async def _scan_and_book(
    sheet_id: str, count: int, user_name: str, start_row: int, end_row: int
) -> list[str]:
    if start_row > end_row or count <= 0:
        return []
    values = await _values_get(sheet_id, f"SUMMARY!A{start_row}:E{end_row}")
    rows = values.get("values", [])
    today = datetime.now(BANGKOK_TZ).strftime("%d/%m/%Y")
    booking_text = f"จองโดย {user_name}"

    booked: list[str] = []
    updates: list[dict] = []
    for i, row in enumerate(rows):
        if len(booked) >= count:
            break
        seq = str(row[0]).strip() if len(row) > 0 and row[0] else ""
        col_e = str(row[4]).strip() if len(row) > 4 and row[4] else ""
        if seq and not col_e:
            target_row = start_row + i
            updates.append({"range": f"SUMMARY!B{target_row}", "values": [[today]]})
            updates.append({"range": f"SUMMARY!E{target_row}", "values": [[booking_text]]})
            booked.append(seq)

    await _batch_update_values(sheet_id, updates)
    return booked


async def _extend_summary_rows(sheet_id: str, last_row: int, extend_count: int) -> None:
    gid = await get_tab_gid(sheet_id, "SUMMARY")
    requests = [
        {
            "insertDimension": {
                "range": {
                    "sheetId": gid,
                    "dimension": "ROWS",
                    "startIndex": last_row,
                    "endIndex": last_row + extend_count,
                },
                "inheritFromBefore": True,
            }
        },
        {
            "copyPaste": {
                "source": {
                    "sheetId": gid,
                    "startRowIndex": last_row - 1,
                    "endRowIndex": last_row,
                    "startColumnIndex": 0,
                    "endColumnIndex": 1,
                },
                "destination": {
                    "sheetId": gid,
                    "startRowIndex": last_row,
                    "endRowIndex": last_row + extend_count,
                    "startColumnIndex": 0,
                    "endColumnIndex": 1,
                },
                "pasteType": "PASTE_FORMULA",
            }
        },
    ]
    await _batch_update(sheet_id, requests)


async def book_seqs(sheet_id: str, count: int, user_name: str) -> list[str]:
    async with sheet_locks.acquire(f"{sheet_id}:SUMMARY:booking"):
        last_row = await _get_last_row(sheet_id, "SUMMARY")
        if last_row < 2:
            raise ValueError('ไม่พบข้อมูลแถว SEQ ในแท็บ SUMMARY')

        booked = await _scan_and_book(sheet_id, count, user_name, start_row=2, end_row=last_row)
        remaining = count - len(booked)

        if remaining > 0:
            extend_count = remaining * 2
            await _extend_summary_rows(sheet_id, last_row, extend_count)
            invalidate_row_cache(sheet_id, "SUMMARY")
            more = await _scan_and_book(
                sheet_id, remaining, user_name, start_row=last_row + 1, end_row=last_row + extend_count
            )
            booked += more

        if not booked:
            raise ValueError("ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ")
        return booked


# ==========================================
# OCR_RESULTS (พอร์ตจาก getOcrResultRowData/recordOcrQueued/handleOcrCallback/getOrCreateOcrResultsSheet)
# ==========================================
OCR_RESULTS_HEADERS = [
    "SEQ", "Timestamp", "Status", "Nationality", "PassportNo", "Sex",
    "RegexName", "PassportEyeName", "Remark", "ImportStatus", "QueuedAtMs",
]
OCR_TIMEOUT_MS = 60 * 1000


@dataclass
class OcrResultRow:
    row_index: int
    status: str
    nationality: str
    passport_no: str
    sex: str
    regex_name: str
    pe_name: str
    remark: str
    import_status: str
    queued_at_ms: int | None


async def _ensure_ocr_results_sheet(sheet_id: str) -> None:
    for props in await _get_sheet_properties(sheet_id):
        if props.get("title") == "OCR_RESULTS":
            return
    service = get_sheets_service()
    await _execute(
        service.spreadsheets().batchUpdate(
            spreadsheetId=sheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": "OCR_RESULTS"}}}]},
        )
    )
    await _batch_update_values(
        sheet_id, [{"range": "OCR_RESULTS!A1", "values": [OCR_RESULTS_HEADERS]}]
    )
    invalidate_row_cache(sheet_id, "OCR_RESULTS")


async def get_ocr_result_row(sheet_id: str, seq: str) -> OcrResultRow | None:
    row = await find_row_by_seq(sheet_id, "OCR_RESULTS", seq)
    if row is None:
        return None
    values = await _values_get(sheet_id, f"OCR_RESULTS!A{row}:K{row}")
    cells = (values.get("values") or [[]])
    cells = cells[0] if cells else []
    cells = cells + [""] * (11 - len(cells))
    queued_raw = str(cells[10]).strip()
    return OcrResultRow(
        row_index=row,
        status=str(cells[2] or ""),
        nationality=str(cells[3] or ""),
        passport_no=str(cells[4] or ""),
        sex=str(cells[5] or ""),
        regex_name=str(cells[6] or ""),
        pe_name=str(cells[7] or ""),
        remark=str(cells[8] or ""),
        import_status=str(cells[9] or ""),
        queued_at_ms=int(queued_raw) if queued_raw.isdigit() else None,
    )


async def _upsert_ocr_row(sheet_id: str, seq: str, row_values: list) -> None:
    async with sheet_locks.acquire(f"{sheet_id}:OCR_RESULTS:{seq}"):
        await _ensure_ocr_results_sheet(sheet_id)
        row = await find_row_by_seq(sheet_id, "OCR_RESULTS", seq)
        if row is None:
            row = await _get_last_row(sheet_id, "OCR_RESULTS") + 1
            invalidate_row_cache(sheet_id, "OCR_RESULTS")
        await _batch_update_values(
            sheet_id, [{"range": f"OCR_RESULTS!A{row}:K{row}", "values": [row_values]}]
        )
        # ล้าง strike-through เดิม เผื่อ SEQ นี้เคยถูกมาร์ค imported จากรอบก่อน (ถ่ายรูปซ้ำ)
        gid = await get_tab_gid(sheet_id, "OCR_RESULTS")
        await _batch_update(
            sheet_id,
            [
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": gid,
                            "startRowIndex": row - 1,
                            "endRowIndex": row,
                            "startColumnIndex": 0,
                            "endColumnIndex": len(OCR_RESULTS_HEADERS),
                        },
                        "cell": {"userEnteredFormat": {"textFormat": {"strikethrough": False}}},
                        "fields": "userEnteredFormat.textFormat.strikethrough",
                    }
                }
            ],
        )


async def record_ocr_queued(sheet_id: str, seq: str) -> None:
    timestamp = datetime.now(BANGKOK_TZ).strftime("%d/%m/%Y %H:%M:%S")
    queued_at_ms = int(time.time() * 1000)
    row_values = [seq, timestamp, "queued", "", "", "", "", "", "", "pending", queued_at_ms]
    await _upsert_ocr_row(sheet_id, seq, row_values)


async def write_ocr_result(
    sheet_id: str,
    seq: str,
    success: bool,
    nationality: str = "",
    passport_no: str = "",
    sex: str = "",
    regex_name: str = "",
    pe_name: str = "",
    remark: str = "",
    error: str = "",
) -> None:
    timestamp = datetime.now(BANGKOK_TZ).strftime("%d/%m/%Y %H:%M:%S")
    if success:
        row_values = [
            seq, timestamp, "done", nationality, passport_no, sex,
            regex_name, pe_name, remark, "pending", "",
        ]
    else:
        row_values = [
            seq, timestamp, "error", "", "", "", "", "",
            error or "OCR failed", "pending", "",
        ]
    await _upsert_ocr_row(sheet_id, seq, row_values)


async def mark_ocr_result_imported(sheet_id: str, row_index: int) -> None:
    gid = await get_tab_gid(sheet_id, "OCR_RESULTS")
    await _batch_update(
        sheet_id,
        [
            {
                "repeatCell": {
                    "range": {
                        "sheetId": gid,
                        "startRowIndex": row_index - 1,
                        "endRowIndex": row_index,
                        "startColumnIndex": 0,
                        "endColumnIndex": len(OCR_RESULTS_HEADERS),
                    },
                    "cell": {"userEnteredFormat": {"textFormat": {"strikethrough": True}}},
                    "fields": "userEnteredFormat.textFormat.strikethrough",
                }
            }
        ],
    )
    await _batch_update_values(sheet_id, [{"range": f"OCR_RESULTS!J{row_index}", "values": [["imported"]]}])


# ==========================================
# PHOTO tab (พอร์ตจาก findSeqRowInSheet/getNextEtcColumn/saveImageUrlToSheetRow)
# ==========================================
PHOTO_COLUMN_BY_TYPE = {"PASSPORT": "D", "Return Ticket": "E", "Accomodation": "F"}
ETC_FIRST_COLUMN_INDEX = 7  # column G


async def find_seq_row_in_photo_tab(sheet_id: str, seq: str) -> int | None:
    return await find_row_by_seq(sheet_id, "PHOTO", seq)


async def get_next_etc_column(sheet_id: str, target_row: int) -> int:
    col = ETC_FIRST_COLUMN_INDEX
    while True:
        col_letter = _column_index_to_letter(col)
        values = await _values_get(sheet_id, f"PHOTO!{col_letter}{target_row}")
        cell = (values.get("values") or [[]])
        cell = cell[0][0] if cell and cell[0] else ""
        if str(cell).strip() == "":
            return col
        col += 1


def _column_index_to_letter(index: int) -> str:
    letters = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


async def save_image_url_to_photo_row(
    sheet_id: str, target_row: int, photo_type: str, image_url: str, etc_col: int | None = None
) -> None:
    image_formula = f'=IMAGE("{image_url}")'
    if photo_type == "ETC":
        if etc_col is None:
            raise ValueError("etc_col is required for photo_type=ETC")
        col_letter = _column_index_to_letter(etc_col)
    else:
        col_letter = PHOTO_COLUMN_BY_TYPE.get(photo_type)
        if col_letter is None:
            return
    await _batch_update_values(
        sheet_id, [{"range": f"PHOTO!{col_letter}{target_row}", "values": [[image_formula]]}]
    )
