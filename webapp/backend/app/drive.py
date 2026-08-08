import asyncio
import io
from dataclasses import dataclass

from googleapiclient.http import MediaIoBaseUpload

from app.config import settings
from app.google_auth import get_drive_service

GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet"
GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"


async def _execute(request) -> dict:
    return await asyncio.to_thread(request.execute)


@dataclass
class DriveSheetInfo:
    id: str
    name: str
    path: str
    updated_ms: int


# ==========================================
# เลือกแผ่นงาน (พอร์ตจาก sendSheetFlexMenu/findAllSheetsRecursive)
# ==========================================
async def _find_folder_by_name(name: str, parent_id: str | None = None) -> str | None:
    service = get_drive_service()
    query = f"name = '{_escape_query(name)}' and mimeType = '{GOOGLE_FOLDER_MIME_TYPE}' and trashed = false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    result = await _execute(service.files().list(q=query, fields="files(id, name)", pageSize=1))
    files = result.get("files", [])
    return files[0]["id"] if files else None


def _escape_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


async def _list_children(folder_id: str) -> list[dict]:
    service = get_drive_service()
    files: list[dict] = []
    page_token = None
    while True:
        result = await _execute(
            service.files().list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="nextPageToken, files(id, name, mimeType, modifiedTime)",
                pageSize=200,
                pageToken=page_token,
            )
        )
        files.extend(result.get("files", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return files


async def _find_all_sheets_recursive(folder_id: str, path_prefix: str) -> list[DriveSheetInfo]:
    results: list[DriveSheetInfo] = []
    children = await _list_children(folder_id)
    for child in children:
        if child["mimeType"] == GOOGLE_SHEETS_MIME_TYPE:
            results.append(
                DriveSheetInfo(
                    id=child["id"],
                    name=child["name"],
                    path=path_prefix,
                    updated_ms=_iso_to_ms(child.get("modifiedTime")),
                )
            )
    for child in children:
        if child["mimeType"] == GOOGLE_FOLDER_MIME_TYPE:
            sub_path = f"{path_prefix}/{child['name']}" if path_prefix else child["name"]
            results.extend(await _find_all_sheets_recursive(child["id"], sub_path))
    return results


def _iso_to_ms(iso_timestamp: str | None) -> int:
    if not iso_timestamp:
        return 0
    from datetime import datetime

    return int(datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).timestamp() * 1000)


async def list_available_sheets(limit: int = 5) -> list[DriveSheetInfo]:
    main_folder_id = await _find_folder_by_name(settings.main_folder_name)
    if main_folder_id is None:
        return []
    sheets = await _find_all_sheets_recursive(main_folder_id, "")
    sheets.sort(key=lambda s: s.updated_ms, reverse=True)
    return sheets[:limit]


# ==========================================
# โฟลเดอร์รูป + อัปโหลด/ค้นหา (พอร์ตจาก getOrCreatePhotoFolder/classifyAndSavePhoto/getPassportPhotoUrl)
# ==========================================
async def _get_or_create_folder(name: str, parent_id: str | None) -> str:
    existing = await _find_folder_by_name(name, parent_id)
    if existing:
        return existing
    service = get_drive_service()
    metadata = {"name": name, "mimeType": GOOGLE_FOLDER_MIME_TYPE}
    if parent_id:
        metadata["parents"] = [parent_id]
    created = await _execute(service.files().create(body=metadata, fields="id"))
    return created["id"]


async def get_or_create_photo_folder(sheet_name: str) -> str:
    main_folder_id = await _get_or_create_folder(settings.main_folder_name, None)
    photo_folder_id = await _get_or_create_folder("PHOTO", main_folder_id)
    return await _get_or_create_folder(sheet_name, photo_folder_id)


def photo_file_name(seq: str, photo_type_label: str, sheet_name: str, etc_index: int | None = None) -> str:
    if etc_index is not None:
        return f"{seq}_ETC_{sheet_name}_{etc_index}.jpg"
    return f"{seq}_{photo_type_label}_{sheet_name}.jpg"


async def find_file_by_name(folder_id: str, file_name: str) -> str | None:
    service = get_drive_service()
    query = f"name = '{_escape_query(file_name)}' and '{folder_id}' in parents and trashed = false"
    result = await _execute(service.files().list(q=query, fields="files(id)", pageSize=1))
    files = result.get("files", [])
    return files[0]["id"] if files else None


async def delete_existing_file(folder_id: str, file_name: str) -> None:
    service = get_drive_service()
    query = f"name = '{_escape_query(file_name)}' and '{folder_id}' in parents and trashed = false"
    result = await _execute(service.files().list(q=query, fields="files(id)"))
    for f in result.get("files", []):
        await _execute(service.files().update(fileId=f["id"], body={"trashed": True}))


async def upload_photo(folder_id: str, file_name: str, content: bytes, mime_type: str = "image/jpeg") -> str:
    """อัปโหลดรูปเข้าโฟลเดอร์ที่ระบุ คืนค่า file id ที่ Drive กำหนดให้"""
    service = get_drive_service()
    media = MediaIoBaseUpload(io.BytesIO(content), mimetype=mime_type, resumable=False)
    metadata = {"name": file_name, "parents": [folder_id]}

    def _call():
        return service.files().create(body=metadata, media_body=media, fields="id").execute()

    result = await asyncio.to_thread(_call)
    return result["id"]


def thumbnail_url(file_id: str, size: str = "w1000") -> str:
    return f"https://drive.google.com/thumbnail?id={file_id}&sz={size}"
