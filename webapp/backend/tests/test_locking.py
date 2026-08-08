import asyncio

import pytest

from app.locking import AsyncKeyedLock


async def test_different_keys_run_concurrently():
    lock = AsyncKeyedLock(timeout=2)
    order = []

    async def hold(key, ms):
        async with lock.acquire(key):
            order.append(f"start:{key}")
            await asyncio.sleep(ms)
            order.append(f"end:{key}")

    await asyncio.gather(hold("a", 0.05), hold("b", 0.05))
    # คนละ key ต้องเริ่มพร้อมกันได้ ไม่ต้องรอกัน
    assert order[0].startswith("start:")
    assert order[1].startswith("start:")


async def test_same_key_serializes():
    lock = AsyncKeyedLock(timeout=2)
    order = []

    async def hold(tag, ms):
        async with lock.acquire("same-key"):
            order.append(f"start:{tag}")
            await asyncio.sleep(ms)
            order.append(f"end:{tag}")

    await asyncio.gather(hold("first", 0.05), hold("second", 0.01))
    # ต้อง end ตัวแรกก่อนถึงจะ start ตัวที่สองได้ (serialize กัน)
    assert order == ["start:first", "end:first", "start:second", "end:second"]


async def test_timeout_raises_when_lock_held_too_long():
    lock = AsyncKeyedLock(timeout=0.05)

    async def hold_forever():
        async with lock.acquire("busy"):
            await asyncio.sleep(1)

    task = asyncio.create_task(hold_forever())
    await asyncio.sleep(0.01)
    with pytest.raises(TimeoutError):
        async with lock.acquire("busy"):
            pass
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
