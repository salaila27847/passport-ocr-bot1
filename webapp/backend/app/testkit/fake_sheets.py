"""
Fake in-memory stand-in for the Google Sheets API surface that app/sheets.py calls.

This does NOT try to be a faithful Sheets clone (no formula evaluation). It models
just enough (A1-notation ranges, batchUpdate requests we actually issue) to verify
our request construction and response parsing are correct without live credentials.
"""
import re

_RANGE_RE = re.compile(r"^([^!]+)!([A-Z]+)(\d*):?([A-Z]*)(\d*)$")


def _col_to_idx(letters: str) -> int:
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - 64)
    return idx


def parse_range(range_str: str):
    m = _RANGE_RE.match(range_str)
    if not m:
        raise ValueError(f"unsupported test range: {range_str}")
    tab, col1, row1, col2, row2 = m.groups()
    col1_idx = _col_to_idx(col1)
    col2_idx = _col_to_idx(col2) if col2 else col1_idx
    row1_idx = int(row1) if row1 else None
    row2_idx = int(row2) if row2 else row1_idx
    return tab, col1_idx, row1_idx, col2_idx, row2_idx


class _Req:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class FakeSheetsService:
    def __init__(self, grid: dict[str, dict[int, dict[int, object]]]):
        # grid: {tab_name: {row_idx(1-based): {col_idx(1-based): value}}}
        self.grid = grid
        self.gid_for_tab = {name: i + 1 for i, name in enumerate(grid)}
        self.batch_update_calls: list[dict] = []
        self.formatting: dict[tuple[str, int], bool] = {}

    # -- chaining shims to mimic googleapiclient's fluent API --
    def spreadsheets(self):
        return self

    def values(self):
        return self

    def get(self, spreadsheetId=None, range=None, fields=None):
        if fields is not None:
            return _Req(self._properties())
        return _Req(self._get_range(range))

    def batchUpdate(self, spreadsheetId=None, body=None):
        self.batch_update_calls.append(body)
        if "data" in body:
            for item in body["data"]:
                self._set_range(item["range"], item["values"])
            return _Req({})
        for req in body.get("requests", []):
            self._apply_request(req)
        return _Req({})

    # -- helpers --
    def _properties(self):
        return {
            "sheets": [
                {
                    "properties": {
                        "title": tab,
                        "sheetId": gid,
                        "gridProperties": {"columnCount": 26},
                    }
                }
                for tab, gid in self.gid_for_tab.items()
            ]
        }

    def _tab_for_gid(self, gid: int) -> str:
        for tab, g in self.gid_for_tab.items():
            if g == gid:
                return tab
        raise KeyError(gid)

    def _get_range(self, range_str: str) -> dict:
        tab, col1, row1, col2, row2 = parse_range(range_str)
        rows = self.grid.get(tab, {})
        if row1 is None:
            if not rows:
                return {}
            row1, row2 = 1, max(rows.keys())

        values = []
        for r in range(row1, row2 + 1):
            row_data = rows.get(r, {})
            row_values = [row_data.get(c, "") for c in range(col1, col2 + 1)]
            while row_values and row_values[-1] == "":
                row_values.pop()
            values.append(row_values)
        while values and not values[-1]:
            values.pop()
        return {"values": values} if values else {}

    def _set_range(self, range_str: str, values: list[list]):
        tab, col1, row1, _col2, _row2 = parse_range(range_str)
        self.grid.setdefault(tab, {})
        for r_offset, row_values in enumerate(values):
            r = row1 + r_offset
            self.grid[tab].setdefault(r, {})
            for c_offset, val in enumerate(row_values):
                self.grid[tab][r][col1 + c_offset] = val

    def _apply_request(self, req: dict):
        if "insertDimension" in req:
            pass  # ทดสอบนี้ insert เฉพาะท้ายชีตเสมอ ไม่ต้อง shift แถวเดิม
        elif "copyPaste" in req:
            self._handle_copy_paste(req["copyPaste"])
        elif "repeatCell" in req:
            self._handle_repeat_cell(req["repeatCell"])
        elif "addSheet" in req:
            title = req["addSheet"]["properties"]["title"]
            self.grid.setdefault(title, {})
            self.gid_for_tab[title] = max(self.gid_for_tab.values(), default=0) + 1

    def _handle_copy_paste(self, copy_paste: dict):
        src = copy_paste["source"]
        dest = copy_paste["destination"]
        tab = self._tab_for_gid(src["sheetId"])
        src_row = src["startRowIndex"] + 1
        src_col = src["startColumnIndex"] + 1
        source_value = self.grid.get(tab, {}).get(src_row, {}).get(src_col, "")
        dest_start = dest["startRowIndex"] + 1
        dest_end = dest["endRowIndex"]
        self.grid.setdefault(tab, {})
        for offset, r in enumerate(range(dest_start, dest_end + 1), start=1):
            # จำลอง auto-increment formula: ถ้าค่าต้นทางเป็นตัวเลข ให้ไล่เลขต่อ (แทนการ evaluate สูตรจริง)
            value = str(int(source_value) + offset) if str(source_value).isdigit() else source_value
            self.grid[tab].setdefault(r, {})[src_col] = value

    def _handle_repeat_cell(self, repeat_cell: dict):
        rng = repeat_cell["range"]
        tab = self._tab_for_gid(rng["sheetId"])
        strikethrough = repeat_cell["cell"]["userEnteredFormat"]["textFormat"]["strikethrough"]
        for r in range(rng["startRowIndex"] + 1, rng["endRowIndex"] + 1):
            self.formatting[(tab, r)] = strikethrough
