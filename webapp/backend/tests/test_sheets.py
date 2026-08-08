import time

import pytest

from app import sheets
from tests.fake_sheets import FakeSheetsService


def make_summary_grid():
    return {
        "SUMMARY": {
            1: {1: "SEQ", 2: "Date", 3: "Flight", 4: "Nat", 5: "Booking", 6: "Name"},
            2: {1: "1"},
            3: {1: "2"},
            4: {1: "3", 5: "จองโดยคนอื่น"},
        }
    }


@pytest.fixture
def fake_service(monkeypatch):
    fake = FakeSheetsService(make_summary_grid())
    monkeypatch.setattr(sheets, "get_sheets_service", lambda: fake)
    return fake


async def test_find_row_by_seq_builds_and_caches_map(fake_service):
    row = await sheets.find_row_by_seq("sheet1", "SUMMARY", "2")
    assert row == 3

    missing = await sheets.find_row_by_seq("sheet1", "SUMMARY", "999")
    assert missing is None


async def test_row_cache_expires_after_ttl(fake_service, monkeypatch):
    await sheets.find_row_by_seq("sheet1", "SUMMARY", "1")
    # เพิ่มแถวใหม่ตรง ๆ ใน grid โดยไม่ invalidate cache -- ต้องยังไม่เห็นจนกว่า TTL หมด
    fake_service.grid["SUMMARY"][5] = {1: "4"}
    assert await sheets.find_row_by_seq("sheet1", "SUMMARY", "4") is None

    # จำลองเวลาผ่านไปเกิน TTL
    key = ("sheet1", "SUMMARY")
    row_map, _expiry = sheets._row_cache[key]
    sheets._row_cache[key] = (row_map, time.monotonic() - 1)
    assert await sheets.find_row_by_seq("sheet1", "SUMMARY", "4") == 5


async def test_invalidate_row_cache_forces_rebuild(fake_service):
    await sheets.find_row_by_seq("sheet1", "SUMMARY", "1")
    fake_service.grid["SUMMARY"][5] = {1: "4"}
    sheets.invalidate_row_cache("sheet1", "SUMMARY")
    assert await sheets.find_row_by_seq("sheet1", "SUMMARY", "4") == 5


async def test_get_column_values_for_dropdown_dedups_and_skips_blank(fake_service):
    fake_service.grid["GROUP"] = {
        1: {1: "หัวข้อ"},
        2: {1: "A"},
        3: {1: "B"},
        4: {1: "A"},
        5: {},
    }
    values = await sheets.get_column_values_for_dropdown("sheet1", "GROUP", "A")
    assert values == ["หัวข้อ", "A", "B"]


async def test_get_column_values_for_dropdown_missing_tab_returns_empty(fake_service):
    values = await sheets.get_column_values_for_dropdown("sheet1", "NOPE", "A")
    assert values == []


async def test_write_then_read_summary_extra_roundtrip(fake_service):
    fields = sheets.SummaryExtra(
        nationality="THA",
        passport_no="AA1234567",
        name="MISS SOMYING SOMSRI",
        sex_f=True,
        group_old="G1",
        group_new="H1",
        visa_now="V1",
        visa_ex="",
        deport=False,
        clauses="C1",
        note="หมายเหตุ",
    )
    ok = await sheets.write_summary_extra("sheet1", "2", fields)
    assert ok is True

    result = await sheets.read_summary_extra("sheet1", "2")
    assert result.nationality == "THA"
    assert result.passport_no == "AA1234567"
    assert result.name == "MISS SOMYING SOMSRI"
    assert result.sex_f is True
    assert result.sex_m is False
    assert result.group_old == "G1"
    assert result.note == "หมายเหตุ"


async def test_write_summary_extra_missing_seq_returns_false(fake_service):
    ok = await sheets.write_summary_extra("sheet1", "does-not-exist", sheets.SummaryExtra(name="X"))
    assert ok is False


def test_has_ocr_edits():
    assert sheets.has_ocr_edits(sheets.SummaryExtra(name="X")) is True
    assert sheets.has_ocr_edits(sheets.SummaryExtra(sex_m=True)) is True
    assert sheets.has_ocr_edits(sheets.SummaryExtra()) is False


async def test_book_seqs_happy_path_skips_already_booked(fake_service):
    booked = await sheets.book_seqs("sheet1", 2, "เจ้าหน้าที่ A")
    assert booked == ["1", "2"]
    assert fake_service.grid["SUMMARY"][2][5] == "จองโดย เจ้าหน้าที่ A"
    assert fake_service.grid["SUMMARY"][3][5] == "จองโดย เจ้าหน้าที่ A"
    # แถว 4 (SEQ 3) จองไว้แล้วก่อนหน้า ต้องไม่ถูกแตะ
    assert fake_service.grid["SUMMARY"][4][5] == "จองโดยคนอื่น"


async def test_book_seqs_auto_extends_when_not_enough_free_rows(fake_service):
    # แถวว่างมีอยู่แค่ 2 แถว (SEQ "1","2") แต่ขอจอง 3 -> ต้อง auto-extend หา SEQ ใหม่มาอีก 1
    booked = await sheets.book_seqs("sheet1", 3, "เจ้าหน้าที่ B")
    assert booked == ["1", "2", "4"]  # "4" มาจากแถวที่ extend เพิ่ม (ไล่เลขต่อจาก SEQ "3" ที่แถวสุดท้าย)

    extend_requests = [
        r for call in fake_service.batch_update_calls for r in call.get("requests", [])
        if "insertDimension" in r
    ]
    assert len(extend_requests) == 1
    req = extend_requests[0]["insertDimension"]
    assert req["range"]["dimension"] == "ROWS"
    assert req["range"]["startIndex"] == 4  # last_row (4) เป็น 0-indexed start
    assert req["range"]["endIndex"] == 4 + 2  # remaining=1 (3 ขอ - 2 จองได้แล้ว) -> extend_count=2


async def test_book_seqs_raises_when_no_data_rows(fake_service):
    # last_row < 2 (ไม่มีแถวข้อมูลเลย นอกจาก header) ต้อง error ทันทีไม่ใช่ auto-extend
    fake_service.grid = {"SUMMARY": {1: {1: "SEQ"}}}
    with pytest.raises(ValueError):
        await sheets.book_seqs("sheet1", 1, "X")


async def test_record_ocr_queued_creates_new_row(fake_service):
    fake_service.grid["OCR_RESULTS"] = {1: {c: h for c, h in enumerate(sheets.OCR_RESULTS_HEADERS, start=1)}}
    await sheets.record_ocr_queued("sheet1", "42")

    row = await sheets.get_ocr_result_row("sheet1", "42")
    assert row is not None
    assert row.status == "queued"
    assert row.import_status == "pending"
    assert row.queued_at_ms is not None


async def test_record_ocr_queued_creates_tab_if_missing(fake_service):
    assert "OCR_RESULTS" not in fake_service.grid
    await sheets.record_ocr_queued("sheet1", "7")
    assert "OCR_RESULTS" in fake_service.grid
    assert fake_service.grid["OCR_RESULTS"][1][1] == "SEQ"  # header row เขียนแล้ว


async def test_write_ocr_result_overwrites_same_seq_row_not_append(fake_service):
    await sheets.record_ocr_queued("sheet1", "42")
    queued_row = await sheets.find_row_by_seq("sheet1", "OCR_RESULTS", "42")

    await sheets.write_ocr_result(
        "sheet1", "42", success=True, nationality="THA", passport_no="AA1", sex="F",
        regex_name="A B", pe_name="A B",
    )
    sheets.invalidate_row_cache("sheet1", "OCR_RESULTS")
    done_row = await sheets.find_row_by_seq("sheet1", "OCR_RESULTS", "42")

    assert done_row == queued_row  # overwrite แถวเดิม ไม่ append แถวใหม่
    result = await sheets.get_ocr_result_row("sheet1", "42")
    assert result.status == "done"
    assert result.nationality == "THA"


async def test_write_ocr_result_error_path(fake_service):
    await sheets.write_ocr_result("sheet1", "99", success=False, error="อ่านไม่ได้")
    result = await sheets.get_ocr_result_row("sheet1", "99")
    assert result.status == "error"
    assert result.remark == "อ่านไม่ได้"


async def test_mark_ocr_result_imported_sets_strikethrough_and_status(fake_service):
    await sheets.record_ocr_queued("sheet1", "42")
    await sheets.write_ocr_result("sheet1", "42", success=True, nationality="THA")
    row = await sheets.find_row_by_seq("sheet1", "OCR_RESULTS", "42")

    await sheets.mark_ocr_result_imported("sheet1", row)

    assert fake_service.formatting[("OCR_RESULTS", row)] is True
    assert fake_service.grid["OCR_RESULTS"][row][10] == "imported"


async def test_get_next_etc_column_finds_first_empty(fake_service):
    fake_service.grid["PHOTO"] = {
        1: {1: "SEQ"},
        2: {1: "5", 7: "=IMAGE(...)", 8: "=IMAGE(...)"},  # G,H ไม่ว่าง -> ต้องได้ I (col 9)
    }
    col = await sheets.get_next_etc_column("sheet1", 2)
    assert col == 9


async def test_save_image_url_to_photo_row_writes_correct_column(fake_service):
    fake_service.grid["PHOTO"] = {1: {1: "SEQ"}, 2: {1: "5"}}
    await sheets.save_image_url_to_photo_row("sheet1", 2, "PASSPORT", "https://example/img.jpg")
    assert fake_service.grid["PHOTO"][2][4] == '=IMAGE("https://example/img.jpg")'  # column D

    await sheets.save_image_url_to_photo_row("sheet1", 2, "ETC", "https://example/etc.jpg", etc_col=9)
    assert fake_service.grid["PHOTO"][2][9] == '=IMAGE("https://example/etc.jpg")'
