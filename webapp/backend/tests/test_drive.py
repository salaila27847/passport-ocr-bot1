from dataclasses import replace

import pytest

from app import drive
from app.testkit.fake_drive import FakeDriveService


@pytest.fixture
def fake_service(monkeypatch):
    fake = FakeDriveService()
    monkeypatch.setattr(drive, "get_drive_service", lambda: fake)
    return fake


async def test_list_available_sheets_sorts_by_recency_and_recurses(fake_service, monkeypatch):
    monkeypatch.setattr(drive, "settings", replace(drive.settings, main_folder_name="interview"))
    root = fake_service.add_folder("interview")
    sub = fake_service.add_folder("groupA", root)
    fake_service.add_sheet("Old Sheet", root, "2026-01-01T00:00:00Z")
    fake_service.add_sheet("New Sheet", root, "2026-03-01T00:00:00Z")
    fake_service.add_sheet("Nested Sheet", sub, "2026-02-01T00:00:00Z")

    results = await drive.list_available_sheets(limit=5)

    assert [r.name for r in results] == ["New Sheet", "Nested Sheet", "Old Sheet"]
    assert results[1].path == "groupA"
    assert results[0].path == ""


async def test_list_available_sheets_missing_main_folder_returns_empty(fake_service, monkeypatch):
    monkeypatch.setattr(drive, "settings", replace(drive.settings, main_folder_name="does-not-exist"))
    results = await drive.list_available_sheets()
    assert results == []


async def test_list_available_sheets_respects_limit(fake_service, monkeypatch):
    monkeypatch.setattr(drive, "settings", replace(drive.settings, main_folder_name="interview"))
    root = fake_service.add_folder("interview")
    for i in range(7):
        fake_service.add_sheet(f"Sheet {i}", root, f"2026-01-0{i+1}T00:00:00Z")
    results = await drive.list_available_sheets(limit=5)
    assert len(results) == 5


def test_photo_file_name_conventions():
    assert drive.photo_file_name("12", "PASSPORT", "GroupA") == "12_PASSPORT_GroupA.jpg"
    assert drive.photo_file_name("12", "ETC", "GroupA", etc_index=2) == "12_ETC_GroupA_2.jpg"


async def test_get_or_create_photo_folder_creates_nested_structure(fake_service, monkeypatch):
    monkeypatch.setattr(drive, "settings", replace(drive.settings, main_folder_name="interview"))
    folder_id = await drive.get_or_create_photo_folder("GroupA")
    assert folder_id in fake_service.files_by_id
    photo_folder = fake_service.files_by_id[folder_id]
    assert photo_folder["name"] == "GroupA"

    # เรียกซ้ำต้องได้โฟลเดอร์เดิม ไม่สร้างซ้ำ
    folder_id_again = await drive.get_or_create_photo_folder("GroupA")
    assert folder_id_again == folder_id
    assert sum(1 for f in fake_service.files_by_id.values() if f["name"] == "GroupA") == 1


async def test_upload_then_find_then_delete_photo(fake_service, monkeypatch):
    monkeypatch.setattr(drive, "settings", replace(drive.settings, main_folder_name="interview"))
    folder_id = await drive.get_or_create_photo_folder("GroupA")

    file_id = await drive.upload_photo(folder_id, "12_PASSPORT_GroupA.jpg", b"fakebytes")
    found = await drive.find_file_by_name(folder_id, "12_PASSPORT_GroupA.jpg")
    assert found == file_id

    await drive.delete_existing_file(folder_id, "12_PASSPORT_GroupA.jpg")
    assert await drive.find_file_by_name(folder_id, "12_PASSPORT_GroupA.jpg") is None


def test_thumbnail_url_format():
    assert drive.thumbnail_url("abc123") == "https://drive.google.com/thumbnail?id=abc123&sz=w1000"
