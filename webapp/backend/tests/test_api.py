"""
Tests the HTTP layer (app/api.py): request parsing, status codes, response shape.
The underlying sheets/drive functions are already covered by test_sheets.py/test_drive.py,
so here we mock them and just verify api.py wires things together and handles errors correctly.
"""
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app import api, drive, sheets
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_mocks(monkeypatch):
    # กันไม่ให้ test ไหนหลุดไปเรียก Google API จริงโดยไม่ตั้งใจ ถ้า mock ไม่ครบ
    monkeypatch.setattr(sheets, "get_sheets_service", lambda: (_ for _ in ()).throw(AssertionError("no mock")))
    monkeypatch.setattr(drive, "get_drive_service", lambda: (_ for _ in ()).throw(AssertionError("no mock")))


def test_list_sheets(monkeypatch):
    fake_sheets = [
        drive.DriveSheetInfo(id="s1", name="Sheet A", path="", updated_ms=100),
        drive.DriveSheetInfo(id="s2", name="Sheet B", path="grp", updated_ms=50),
    ]
    monkeypatch.setattr(drive, "list_available_sheets", AsyncMock(return_value=fake_sheets))

    res = client.get("/sheets")
    assert res.status_code == 200
    assert res.json() == [
        {"id": "s1", "name": "Sheet A", "path": "", "updated_ms": 100},
        {"id": "s2", "name": "Sheet B", "path": "grp", "updated_ms": 50},
    ]


def test_get_dropdowns_calls_all_four_columns(monkeypatch):
    calls = []

    async def fake_dropdown(sheet_id, tab, col):
        calls.append((sheet_id, tab, col))
        return [f"{tab}-{col}"]

    monkeypatch.setattr(sheets, "get_column_values_for_dropdown", fake_dropdown)

    res = client.get("/sheets/sheet1/dropdowns")
    assert res.status_code == 200
    assert res.json() == {
        "group_old": ["GROUP-A"],
        "group_new": ["GROUP-B"],
        "visa": ["VISA-M"],
        "clause": ["CLAUSE-A"],
    }
    assert ("sheet1", "GROUP", "A") in calls
    assert ("sheet1", "VISA", "M") in calls


def test_book_seqs_success_also_writes_flight_no(monkeypatch):
    book_mock = AsyncMock(return_value=["1", "2"])
    flight_mock = AsyncMock()
    monkeypatch.setattr(sheets, "book_seqs", book_mock)
    monkeypatch.setattr(sheets, "update_flight_no", flight_mock)

    res = client.post(
        "/sheets/sheet1/bookings",
        json={"count": 2, "user_name": "เจ้าหน้าที่ A", "flight_no": "TG123"},
    )

    assert res.status_code == 200
    assert res.json() == {"booked_seqs": ["1", "2"]}
    book_mock.assert_awaited_once_with("sheet1", 2, "เจ้าหน้าที่ A")
    flight_mock.assert_awaited_once_with("sheet1", ["1", "2"], "TG123")


def test_book_seqs_without_flight_no_skips_that_call(monkeypatch):
    monkeypatch.setattr(sheets, "book_seqs", AsyncMock(return_value=["1"]))
    flight_mock = AsyncMock()
    monkeypatch.setattr(sheets, "update_flight_no", flight_mock)

    res = client.post("/sheets/sheet1/bookings", json={"count": 1, "user_name": "X"})

    assert res.status_code == 200
    flight_mock.assert_not_awaited()


def test_book_seqs_full_sheet_returns_409(monkeypatch):
    monkeypatch.setattr(
        sheets, "book_seqs", AsyncMock(side_effect=ValueError("ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ"))
    )
    res = client.post("/sheets/sheet1/bookings", json={"count": 1, "user_name": "X"})
    assert res.status_code == 409
    assert "ไม่มีแถว SEQ ว่าง" in res.json()["detail"]


def test_get_extra_info_not_found_returns_404(monkeypatch):
    monkeypatch.setattr(sheets, "read_summary_extra", AsyncMock(return_value=None))
    res = client.get("/sheets/sheet1/seq/999/extra-info", params={"sheet_name": "GroupA"})
    assert res.status_code == 404


def test_get_extra_info_success_includes_dropdowns_and_photo(monkeypatch):
    monkeypatch.setattr(
        sheets,
        "read_summary_extra",
        AsyncMock(return_value=sheets.SummaryExtra(nationality="THA", name="A B", sex_f=True)),
    )
    monkeypatch.setattr(sheets, "get_column_values_for_dropdown", AsyncMock(return_value=["X"]))
    monkeypatch.setattr(api, "_find_photo_url", AsyncMock(return_value="https://example/photo.jpg"))

    res = client.get("/sheets/sheet1/seq/5/extra-info", params={"sheet_name": "GroupA"})
    assert res.status_code == 200
    body = res.json()
    assert body["nationality"] == "THA"
    assert body["name"] == "A B"
    assert body["sex_f"] is True
    assert body["passport_photo_url"] == "https://example/photo.jpg"
    assert body["dropdowns"]["group_old"] == ["X"]


def test_save_extra_info_marks_ocr_imported_when_done(monkeypatch):
    monkeypatch.setattr(sheets, "write_summary_extra", AsyncMock(return_value=True))
    monkeypatch.setattr(
        sheets,
        "get_ocr_result_row",
        AsyncMock(return_value=sheets.OcrResultRow(
            row_index=7, status="done", nationality="THA", passport_no="", sex="",
            regex_name="", pe_name="", remark="", import_status="pending", queued_at_ms=None,
        )),
    )
    mark_mock = AsyncMock()
    monkeypatch.setattr(sheets, "mark_ocr_result_imported", mark_mock)

    res = client.put("/sheets/sheet1/seq/5/extra-info", json={"nationality": "THA"})
    assert res.status_code == 200
    assert res.json() == {"success": True}
    mark_mock.assert_awaited_once_with("sheet1", 7)


def test_save_extra_info_skips_ocr_mark_when_no_ocr_fields_touched(monkeypatch):
    monkeypatch.setattr(sheets, "write_summary_extra", AsyncMock(return_value=True))
    ocr_mock = AsyncMock()
    monkeypatch.setattr(sheets, "get_ocr_result_row", ocr_mock)

    res = client.put("/sheets/sheet1/seq/5/extra-info", json={"group_old": "G1"})
    assert res.status_code == 200
    ocr_mock.assert_not_awaited()


def test_save_extra_info_missing_seq_returns_404(monkeypatch):
    monkeypatch.setattr(sheets, "write_summary_extra", AsyncMock(return_value=False))
    res = client.put("/sheets/sheet1/seq/999/extra-info", json={"name": "X"})
    assert res.status_code == 404


def test_ocr_preview_not_found(monkeypatch):
    monkeypatch.setattr(sheets, "get_ocr_result_row", AsyncMock(return_value=None))
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    assert res.status_code == 200
    assert res.json()["status"] == "not_found"


def test_ocr_preview_queued_within_timeout(monkeypatch):
    import time as time_module

    monkeypatch.setattr(
        sheets,
        "get_ocr_result_row",
        AsyncMock(return_value=sheets.OcrResultRow(
            row_index=1, status="queued", nationality="", passport_no="", sex="",
            regex_name="", pe_name="", remark="", import_status="pending",
            queued_at_ms=int(time_module.time() * 1000),
        )),
    )
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    assert res.json()["status"] == "queued"


def test_ocr_preview_queued_past_timeout_reports_error(monkeypatch):
    monkeypatch.setattr(
        sheets,
        "get_ocr_result_row",
        AsyncMock(return_value=sheets.OcrResultRow(
            row_index=1, status="queued", nationality="", passport_no="", sex="",
            regex_name="", pe_name="", remark="", import_status="pending",
            queued_at_ms=0,  # นานมากแล้วตั้งแต่ epoch -> เกิน timeout แน่นอน
        )),
    )
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    assert res.json()["status"] == "error"


def test_ocr_preview_error_status(monkeypatch):
    monkeypatch.setattr(
        sheets,
        "get_ocr_result_row",
        AsyncMock(return_value=sheets.OcrResultRow(
            row_index=1, status="error", nationality="", passport_no="", sex="",
            regex_name="", pe_name="", remark="อ่านไม่ออก", import_status="pending", queued_at_ms=None,
        )),
    )
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    body = res.json()
    assert body["status"] == "error"
    assert "อ่านไม่ออก" in body["message"]


def test_ocr_preview_done_status(monkeypatch):
    monkeypatch.setattr(
        sheets,
        "get_ocr_result_row",
        AsyncMock(return_value=sheets.OcrResultRow(
            row_index=1, status="done", nationality="THA", passport_no="AA1", sex="M",
            regex_name="A B", pe_name="A B", remark="", import_status="pending", queued_at_ms=None,
        )),
    )
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    body = res.json()
    assert body["status"] == "done"
    assert body["nationality"] == "THA"
    assert body["regex_name"] == "A B"


def test_upload_photo_rejects_unknown_photo_type():
    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "NOT_A_TYPE"},
        files={"file": ("a.jpg", b"bytes", "image/jpeg")},
    )
    assert res.status_code == 400


def test_upload_photo_missing_seq_returns_404(monkeypatch):
    monkeypatch.setattr(sheets, "find_seq_row_in_photo_tab", AsyncMock(return_value=None))
    res = client.post(
        "/sheets/sheet1/seq/999/photos",
        data={"sheet_name": "GroupA", "photo_type": "PASSPORT"},
        files={"file": ("a.jpg", b"bytes", "image/jpeg")},
    )
    assert res.status_code == 404


def test_upload_photo_standard_type_overwrites_and_saves(monkeypatch):
    monkeypatch.setattr(sheets, "find_seq_row_in_photo_tab", AsyncMock(return_value=3))
    monkeypatch.setattr(drive, "get_or_create_photo_folder", AsyncMock(return_value="folder1"))
    delete_mock = AsyncMock()
    monkeypatch.setattr(drive, "delete_existing_file", delete_mock)
    monkeypatch.setattr(drive, "upload_photo", AsyncMock(return_value="file1"))
    save_mock = AsyncMock()
    monkeypatch.setattr(sheets, "save_image_url_to_photo_row", save_mock)

    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "PASSPORT"},
        files={"file": ("a.jpg", b"bytes", "image/jpeg")},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["photo_type"] == "PASSPORT"
    assert body["url"] == "https://drive.google.com/thumbnail?id=file1&sz=w1000"
    delete_mock.assert_awaited_once_with("folder1", "5_PASSPORT_GroupA.jpg")
    save_mock.assert_awaited_once_with("sheet1", 3, "PASSPORT", body["url"])


def test_upload_photo_etc_type_allocates_column(monkeypatch):
    monkeypatch.setattr(sheets, "find_seq_row_in_photo_tab", AsyncMock(return_value=3))
    monkeypatch.setattr(drive, "get_or_create_photo_folder", AsyncMock(return_value="folder1"))
    monkeypatch.setattr(sheets, "get_next_etc_column", AsyncMock(return_value=8))  # column H -> index 2
    monkeypatch.setattr(drive, "upload_photo", AsyncMock(return_value="file2"))
    save_mock = AsyncMock()
    monkeypatch.setattr(sheets, "save_image_url_to_photo_row", save_mock)

    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "ETC"},
        files={"file": ("a.jpg", b"bytes", "image/jpeg")},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["url"] == "https://drive.google.com/thumbnail?id=file2&sz=w1000"
    save_mock.assert_awaited_once_with("sheet1", 3, "ETC", body["url"], etc_col=8)


def test_get_photo_not_found_returns_404(monkeypatch):
    monkeypatch.setattr(api, "_find_photo_url", AsyncMock(return_value=""))
    res = client.get("/sheets/sheet1/seq/5/photo", params={"sheet_name": "GroupA", "photo_type": "PASSPORT"})
    assert res.status_code == 404


def test_get_photo_found(monkeypatch):
    monkeypatch.setattr(api, "_find_photo_url", AsyncMock(return_value="https://example/x.jpg"))
    res = client.get("/sheets/sheet1/seq/5/photo", params={"sheet_name": "GroupA", "photo_type": "PASSPORT"})
    assert res.status_code == 200
    assert res.json() == {"photo_type": "PASSPORT", "url": "https://example/x.jpg"}
