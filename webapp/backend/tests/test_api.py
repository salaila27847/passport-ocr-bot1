"""
Tests the HTTP layer (app/api.py): request parsing, status codes, response shape.
The underlying sheets/drive functions are already covered by test_sheets.py/test_drive.py,
so here we mock them and just verify api.py wires things together and handles errors correctly.
"""
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app import api, drive, sheets
from app.auth import StaffUser, require_staff_user
from app.main import app

client = TestClient(app)

TEST_STAFF = StaffUser(email="staff@example.com", name="Staff Tester")


@pytest.fixture(autouse=True)
def _reset_mocks(monkeypatch):
    # กันไม่ให้ test ไหนหลุดไปเรียก Google API จริงโดยไม่ตั้งใจ ถ้า mock ไม่ครบ
    monkeypatch.setattr(sheets, "get_sheets_service", lambda: (_ for _ in ()).throw(AssertionError("no mock")))
    monkeypatch.setattr(drive, "get_drive_service", lambda: (_ for _ in ()).throw(AssertionError("no mock")))
    # ทุก endpoint อยู่หลัง require_staff_user แล้ว — override เป็นผู้ใช้ทดสอบคงที่แทนการยิง Google จริง
    app.dependency_overrides[require_staff_user] = lambda: TEST_STAFF
    yield
    app.dependency_overrides.pop(require_staff_user, None)


def test_unauthenticated_request_rejected_end_to_end():
    # ยืนยันว่า router-level auth dependency ทำงานจริง ไม่ใช่แค่เชื่อว่าเขียนถูก — เอา override ออกชั่วคราว
    app.dependency_overrides.pop(require_staff_user, None)
    try:
        res = client.get("/sheets")
        assert res.status_code == 401
    finally:
        app.dependency_overrides[require_staff_user] = lambda: TEST_STAFF


def test_me_endpoint_returns_authenticated_identity():
    res = client.get("/me")
    assert res.status_code == 200
    assert res.json() == {"email": TEST_STAFF.email, "name": TEST_STAFF.name}


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
        json={"count": 2, "flight_no": "TG123"},
    )

    assert res.status_code == 200
    assert res.json() == {"booked_seqs": ["1", "2"]}
    book_mock.assert_awaited_once_with("sheet1", 2, TEST_STAFF.name)  # ชื่อมาจาก auth ไม่ใช่ client-supplied
    flight_mock.assert_awaited_once_with("sheet1", ["1", "2"], "TG123")


def test_book_seqs_without_flight_no_skips_that_call(monkeypatch):
    monkeypatch.setattr(sheets, "book_seqs", AsyncMock(return_value=["1"]))
    flight_mock = AsyncMock()
    monkeypatch.setattr(sheets, "update_flight_no", flight_mock)

    res = client.post("/sheets/sheet1/bookings", json={"count": 1})

    assert res.status_code == 200
    flight_mock.assert_not_awaited()


def test_book_seqs_full_sheet_returns_409(monkeypatch):
    monkeypatch.setattr(
        sheets, "book_seqs", AsyncMock(side_effect=ValueError("ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ"))
    )
    res = client.post("/sheets/sheet1/bookings", json={"count": 1})
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
            pe_name="", typhoon_name="", remark="", import_status="pending", queued_at_ms=None,
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
            pe_name="", typhoon_name="", remark="", import_status="pending",
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
            pe_name="", typhoon_name="", remark="", import_status="pending",
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
            pe_name="", typhoon_name="", remark="อ่านไม่ออก", import_status="pending", queued_at_ms=None,
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
            pe_name="A B", typhoon_name="A B", remark="", import_status="pending", queued_at_ms=None,
        )),
    )
    res = client.get("/sheets/sheet1/seq/1/ocr-preview")
    body = res.json()
    assert body["status"] == "done"
    assert body["nationality"] == "THA"
    assert body["typhoon_name"] == "A B"


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

    # ใช้ Accomodation แทน PASSPORT เพราะ PASSPORT/Return Ticket ตอนนี้ trigger OCR background job
    # ด้วย (ทดสอบแยกไว้ในเคสของมันเองด้านล่าง) เคสนี้โฟกัสแค่กลไก overwrite/บันทึกไฟล์ทั่วไป
    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "Accomodation"},
        files={"file": ("a.jpg", b"bytes", "image/jpeg")},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["photo_type"] == "Accomodation"
    assert body["ocr_queued"] is False
    assert body["url"] == "https://drive.google.com/thumbnail?id=file1&sz=w1000"
    delete_mock.assert_awaited_once_with("folder1", "5_ACCOMMODATION_GroupA.jpg")
    save_mock.assert_awaited_once_with("sheet1", 3, "Accomodation", body["url"])


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


def test_upload_photo_passport_triggers_ocr_background_job(monkeypatch):
    monkeypatch.setattr(sheets, "find_seq_row_in_photo_tab", AsyncMock(return_value=3))
    monkeypatch.setattr(drive, "get_or_create_photo_folder", AsyncMock(return_value="folder1"))
    monkeypatch.setattr(drive, "delete_existing_file", AsyncMock())
    monkeypatch.setattr(drive, "upload_photo", AsyncMock(return_value="file1"))
    monkeypatch.setattr(sheets, "save_image_url_to_photo_row", AsyncMock())
    queued_mock = AsyncMock()
    monkeypatch.setattr(sheets, "record_ocr_queued", queued_mock)
    job_mock = AsyncMock()
    monkeypatch.setattr(api, "run_passport_ocr_job", job_mock)

    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "PASSPORT"},
        files={"file": ("a.jpg", b"passportbytes", "image/jpeg")},
    )

    assert res.status_code == 200
    assert res.json()["ocr_queued"] is True
    queued_mock.assert_awaited_once_with("sheet1", "5")
    # BackgroundTasks รันจริงหลังตอบ response แล้วภายใน TestClient เดียวกัน เลยเช็คได้ทันที
    job_mock.assert_awaited_once_with("sheet1", "5", b"passportbytes")


def test_upload_photo_return_ticket_triggers_flight_no_job_not_ocr_queued(monkeypatch):
    monkeypatch.setattr(sheets, "find_seq_row_in_photo_tab", AsyncMock(return_value=3))
    monkeypatch.setattr(drive, "get_or_create_photo_folder", AsyncMock(return_value="folder1"))
    monkeypatch.setattr(drive, "delete_existing_file", AsyncMock())
    monkeypatch.setattr(drive, "upload_photo", AsyncMock(return_value="file1"))
    monkeypatch.setattr(sheets, "save_image_url_to_photo_row", AsyncMock())
    ticket_job_mock = AsyncMock()
    monkeypatch.setattr(api, "run_ticket_ocr_job", ticket_job_mock)

    res = client.post(
        "/sheets/sheet1/seq/5/photos",
        data={"sheet_name": "GroupA", "photo_type": "Return Ticket"},
        files={"file": ("a.jpg", b"ticketbytes", "image/jpeg")},
    )

    assert res.status_code == 200
    assert res.json()["ocr_queued"] is False  # ไม่ใช่ passport, ไม่ต้อง poll ocr-preview
    ticket_job_mock.assert_awaited_once_with("sheet1", "5", b"ticketbytes")


def test_get_photo_not_found_returns_404(monkeypatch):
    monkeypatch.setattr(api, "_find_photo_url", AsyncMock(return_value=""))
    res = client.get("/sheets/sheet1/seq/5/photo", params={"sheet_name": "GroupA", "photo_type": "PASSPORT"})
    assert res.status_code == 404


def test_get_photo_found(monkeypatch):
    monkeypatch.setattr(api, "_find_photo_url", AsyncMock(return_value="https://example/x.jpg"))
    res = client.get("/sheets/sheet1/seq/5/photo", params={"sheet_name": "GroupA", "photo_type": "PASSPORT"})
    assert res.status_code == 200
    assert res.json() == {"photo_type": "PASSPORT", "url": "https://example/x.jpg", "ocr_queued": False}
