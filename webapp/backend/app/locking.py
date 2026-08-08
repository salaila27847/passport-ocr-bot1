import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager

# แทน LockService.getScriptLock() ของ GAS ที่ล็อกทั้งสคริปต์ทุกครั้ง — ที่นี่ล็อกเฉพาะ key
# (เช่น ต่อแถว/ต่อ SEQ) ทำให้เจ้าหน้าที่คนละ SEQ ทำงานพร้อมกันได้จริง ไม่ต้องรอคิวเดียวกันทั้งหมด


class AsyncKeyedLock:
    def __init__(self, timeout: float = 15.0):
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._timeout = timeout

    @asynccontextmanager
    async def acquire(self, key: str):
        lock = self._locks[key]
        try:
            await asyncio.wait_for(lock.acquire(), timeout=self._timeout)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"ระบบกำลังประมวลผลรายการอื่นอยู่ กรุณาลองใหม่อีกครั้งครับ (key={key})"
            ) from exc
        try:
            yield
        finally:
            lock.release()
