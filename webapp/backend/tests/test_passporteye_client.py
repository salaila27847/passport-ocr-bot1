import io
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from app.ocr import passporteye_client as pe


def _jpeg_bytes(size=(100, 100)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color="white").save(buf, format="JPEG")
    return buf.getvalue()


def test_is_noise_token_detects_repeated_letters():
    assert pe.is_noise_token("KKKKK") is True


def test_is_noise_token_detects_consonant_only():
    assert pe.is_noise_token("BCDFG") is True


def test_is_noise_token_accepts_real_word():
    assert pe.is_noise_token("SOMYING") is False


def test_is_noise_token_empty_is_noise():
    assert pe.is_noise_token("") is True


def test_clean_name_field_filters_noise_and_single_char_tokens():
    # KKKKK (ตัวซ้ำ) และ BCDFG (ไม่มีสระ) ถูกกรองเป็น noise, "A" ถูกกรองเพราะสั้นเกินไป (<2 ตัวอักษร)
    assert pe.clean_name_field("SOMYING<<KKKKK<A<DE<BCDFG") == "SOMYING DE"


def test_clean_name_field_empty_input():
    assert pe.clean_name_field("") == ""


def _fake_mrz(valid_score, surname="SOMSRI", names="SOMYING", nationality_line="THATHA1234567890123456789012"):
    raw_text = f"P<THASOMSRI<<SOMYING<<<<<<<<<<<<<<<<<<<<<<<\n{nationality_line}\n"
    return SimpleNamespace(
        to_dict=lambda: {
            "number": "AA1234567",
            "surname": surname,
            "names": names,
            "date_of_birth": "900101",
            "expiration_date": "300101",
            "country": "THA",
            "nationality": "THA",
            "sex": "F",
        },
        raw_text=raw_text,
        valid_score=valid_score,
    )


def test_parse_mrz_maps_fields_and_cleans_names():
    with patch.object(pe, "read_mrz", return_value=_fake_mrz(85)):
        result = pe._parse_mrz("fake_path.jpg")
    assert result is not None
    assert result.passport_number == "AA1234567"
    assert result.surname == "SOMSRI"
    assert result.given_names == "SOMYING"
    assert result.full_name == "SOMYING SOMSRI"
    assert result.sex == "F"
    assert result.valid_score == 85


def test_parse_mrz_detects_nationality_mismatch():
    mrz = _fake_mrz(85, nationality_line="GBRTHA1234567890123456789012")
    with patch.object(pe, "read_mrz", return_value=mrz):
        result = pe._parse_mrz("fake_path.jpg")
    assert result.nationality_mismatch is True
    assert result.remark != ""


def test_parse_mrz_returns_none_when_mrz_not_found():
    with patch.object(pe, "read_mrz", return_value=None):
        assert pe._parse_mrz("fake_path.jpg") is None


def test_parse_mrz_returns_none_on_exception():
    with patch.object(pe, "read_mrz", side_effect=RuntimeError("boom")):
        assert pe._parse_mrz("fake_path.jpg") is None


async def test_run_passporteye_returns_first_result_when_score_above_threshold(monkeypatch):
    monkeypatch.setattr(pe, "MIN_ACCEPTABLE_SCORE", 70)
    good_result = pe.PassportEyeResult(valid_score=90, full_name="GOOD RESULT")
    with patch.object(pe, "_parse_mrz", return_value=good_result) as parse_mock:
        result = await pe.run_passporteye(_jpeg_bytes())
    assert result.full_name == "GOOD RESULT"
    parse_mock.assert_called_once()  # ไม่ต้อง enhance-retry เพราะคะแนนผ่านเกณฑ์ตั้งแต่รอบแรก


async def test_run_passporteye_retries_with_enhanced_image_when_score_low(monkeypatch):
    monkeypatch.setattr(pe, "MIN_ACCEPTABLE_SCORE", 70)
    low_result = pe.PassportEyeResult(valid_score=50, full_name="LOW")
    high_result = pe.PassportEyeResult(valid_score=80, full_name="HIGH")

    calls = {"n": 0}

    def fake_parse(path):
        calls["n"] += 1
        return low_result if calls["n"] == 1 else high_result

    with patch.object(pe, "_parse_mrz", side_effect=fake_parse):
        result = await pe.run_passporteye(_jpeg_bytes())

    assert calls["n"] == 2
    assert result.full_name == "HIGH"  # เลือกผลที่คะแนนสูงกว่า


async def test_run_passporteye_keeps_first_result_if_enhanced_is_worse(monkeypatch):
    monkeypatch.setattr(pe, "MIN_ACCEPTABLE_SCORE", 70)
    low_result = pe.PassportEyeResult(valid_score=50, full_name="LOW")
    worse_result = pe.PassportEyeResult(valid_score=40, full_name="WORSE")

    calls = {"n": 0}

    def fake_parse(path):
        calls["n"] += 1
        return low_result if calls["n"] == 1 else worse_result

    with patch.object(pe, "_parse_mrz", side_effect=fake_parse):
        result = await pe.run_passporteye(_jpeg_bytes())

    assert result.full_name == "LOW"


async def test_run_passporteye_returns_none_when_mrz_never_found():
    with patch.object(pe, "_parse_mrz", return_value=None):
        result = await pe.run_passporteye(_jpeg_bytes())
    assert result is None


async def test_run_passporteye_cleans_up_temp_files(monkeypatch, tmp_path):
    monkeypatch.setattr(pe, "MIN_ACCEPTABLE_SCORE", 70)
    created_paths = []

    orig_downscale = pe._downscale_if_needed

    def spy_downscale(src, dest):
        created_paths.append(src)
        return orig_downscale(src, dest)

    good_result = pe.PassportEyeResult(valid_score=90, full_name="X")
    with patch.object(pe, "_downscale_if_needed", side_effect=spy_downscale), \
         patch.object(pe, "_parse_mrz", return_value=good_result):
        await pe.run_passporteye(_jpeg_bytes())

    import os
    assert created_paths, "downscale should have been called with the temp file path"
    assert not os.path.exists(created_paths[0]), "temp file must be cleaned up after the pipeline runs"
