"""Fake in-memory Drive API surface for app/drive.py tests."""


class _Req:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class FakeDriveService:
    def __init__(self):
        self._next_id = 1
        # files: id -> {"name", "mimeType", "parents": [id], "modifiedTime", "trashed"}
        self.files_by_id: dict[str, dict] = {}

    def _new_id(self) -> str:
        file_id = f"file{self._next_id}"
        self._next_id += 1
        return file_id

    def add_folder(self, name: str, parent_id: str | None = None) -> str:
        return self._add(name, "application/vnd.google-apps.folder", parent_id)

    def add_sheet(self, name: str, parent_id: str, modified_time: str) -> str:
        return self._add(name, "application/vnd.google-apps.spreadsheet", parent_id, modified_time)

    def _add(self, name, mime_type, parent_id=None, modified_time="2026-01-01T00:00:00Z") -> str:
        file_id = self._new_id()
        self.files_by_id[file_id] = {
            "id": file_id,
            "name": name,
            "mimeType": mime_type,
            "parents": [parent_id] if parent_id else [],
            "modifiedTime": modified_time,
            "trashed": False,
        }
        return file_id

    def files(self):
        return self

    def list(self, q=None, fields=None, pageSize=None, pageToken=None):
        matches = [f for f in self.files_by_id.values() if self._matches(f, q)]
        return _Req({"files": matches})

    def create(self, body=None, media_body=None, fields=None):
        file_id = self._new_id()
        self.files_by_id[file_id] = {
            "id": file_id,
            "name": body["name"],
            "mimeType": body.get("mimeType", "application/octet-stream"),
            "parents": body.get("parents", []),
            "modifiedTime": "2026-01-01T00:00:00Z",
            "trashed": False,
        }
        return _Req({"id": file_id})

    def update(self, fileId=None, body=None):
        self.files_by_id[fileId].update(body)
        return _Req({"id": fileId})

    @staticmethod
    def _matches(f: dict, q: str | None) -> bool:
        if f["trashed"]:
            return False
        if q is None:
            return True
        if "trashed = false" not in q:
            pass  # ทุก query ของเราใส่ trashed = false เสมอ ไม่ต้องแยกแยะเพิ่ม
        if "mimeType = " in q:
            import re

            m = re.search(r"mimeType = '([^']+)'", q)
            if m and f["mimeType"] != m.group(1):
                return False
        if "name = " in q:
            import re

            m = re.search(r"name = '([^']+)'", q)
            if m and f["name"] != m.group(1):
                return False
        if " in parents" in q:
            import re

            m = re.search(r"'([^']+)' in parents", q)
            if m and m.group(1) not in f["parents"]:
                return False
        return True
