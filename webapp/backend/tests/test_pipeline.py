from unittest.mock import AsyncMock

from app import sheets
from app.ocr import pipeline
from app.ocr.passporteye_client import PassportEyeResult
from app.ocr.typhoon_client import TyphoonOcrError


async def test_run_passport_ocr_job_success_combines_both_sources(monkeypatch):
    pe_result = PassportEyeResult(
        valid_score=90, nationality="THA", passport_number="AA1", sex="F",
        full_name="PE NAME", remark="",
    )
    monkeypatch.setattr(pipeline, "run_passporteye", AsyncMock(return_value=pe_result))
    monkeypatch.setattr(pipeline, "extract_passport_name", AsyncMock(return_value="TYPHOON NAME"))
    write_mock = AsyncMock()
    monkeypatch.setattr(sheets, "write_ocr_result", write_mock)

    await pipeline.run_passport_ocr_job("sheet1", "5", b"bytes")

    write_mock.assert_awaited_once_with(
        "sheet1", "5", success=True,
        nationality="THA", passport_no="AA1", sex="F",
        pe_name="PE NAME", typhoon_name="TYPHOON NAME", remark="",
    )


async def test_run_passport_ocr_job_typhoon_failure_falls_back_to_passporteye_only(monkeypatch):
    pe_result = PassportEyeResult(valid_score=90, full_name="PE NAME")
    monkeypatch.setattr(pipeline, "run_passporteye", AsyncMock(return_value=pe_result))
    monkeypatch.setattr(pipeline, "extract_passport_name", AsyncMock(side_effect=TyphoonOcrError("down")))
    write_mock = AsyncMock()
    monkeypatch.setattr(sheets, "write_ocr_result", write_mock)

    await pipeline.run_passport_ocr_job("sheet1", "5", b"bytes")

    assert write_mock.await_args.kwargs["success"] is True
    assert write_mock.await_args.kwargs["typhoon_name"] == ""
    assert write_mock.await_args.kwargs["pe_name"] == "PE NAME"


async def test_run_passport_ocr_job_passporteye_none_writes_error(monkeypatch):
    monkeypatch.setattr(pipeline, "run_passporteye", AsyncMock(return_value=None))
    monkeypatch.setattr(pipeline, "extract_passport_name", AsyncMock(return_value=""))
    write_mock = AsyncMock()
    monkeypatch.setattr(sheets, "write_ocr_result", write_mock)

    await pipeline.run_passport_ocr_job("sheet1", "5", b"bytes")

    assert write_mock.await_args.kwargs["success"] is False
    assert "MRZ" in write_mock.await_args.kwargs["error"]


async def test_run_passport_ocr_job_unexpected_exception_still_writes_error(monkeypatch):
    monkeypatch.setattr(pipeline, "run_passporteye", AsyncMock(side_effect=RuntimeError("disk full")))
    monkeypatch.setattr(pipeline, "extract_passport_name", AsyncMock(return_value=""))
    write_mock = AsyncMock()
    monkeypatch.setattr(sheets, "write_ocr_result", write_mock)

    await pipeline.run_passport_ocr_job("sheet1", "5", b"bytes")

    assert write_mock.await_args.kwargs["success"] is False
    assert "disk full" in write_mock.await_args.kwargs["error"]


async def test_run_ticket_ocr_job_updates_flight_no_when_found(monkeypatch):
    monkeypatch.setattr(
        pipeline, "extract_ticket_fields",
        AsyncMock(return_value={"flight_no": "TG123", "travel_date": "01 JAN"}),
    )
    update_mock = AsyncMock()
    monkeypatch.setattr(sheets, "update_flight_no", update_mock)

    await pipeline.run_ticket_ocr_job("sheet1", "5", b"bytes")

    update_mock.assert_awaited_once_with("sheet1", ["5"], "TG123")


async def test_run_ticket_ocr_job_skips_update_when_flight_no_not_found(monkeypatch):
    monkeypatch.setattr(
        pipeline, "extract_ticket_fields", AsyncMock(return_value={"flight_no": "", "travel_date": ""})
    )
    update_mock = AsyncMock()
    monkeypatch.setattr(sheets, "update_flight_no", update_mock)

    await pipeline.run_ticket_ocr_job("sheet1", "5", b"bytes")

    update_mock.assert_not_awaited()


async def test_run_ticket_ocr_job_typhoon_error_fails_silently(monkeypatch):
    monkeypatch.setattr(pipeline, "extract_ticket_fields", AsyncMock(side_effect=TyphoonOcrError("down")))
    update_mock = AsyncMock()
    monkeypatch.setattr(sheets, "update_flight_no", update_mock)

    await pipeline.run_ticket_ocr_job("sheet1", "5", b"bytes")  # ต้องไม่ throw ออกมา

    update_mock.assert_not_awaited()
