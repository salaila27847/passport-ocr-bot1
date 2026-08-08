from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.ocr import typhoon_client as tc


class _FakeCompletions:
    def __init__(self, content: str):
        self._content = content
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self._content))])


class _FakeChat:
    def __init__(self, content: str):
        self.completions = _FakeCompletions(content)


class _FakeOpenAI:
    def __init__(self, content: str = "{}", raise_on_create: Exception | None = None):
        self.chat = _FakeChat(content)
        if raise_on_create is not None:
            def _raise(**kwargs):
                raise raise_on_create
            self.chat.completions.create = _raise


def _tiny_jpeg() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _fake_settings(monkeypatch):
    monkeypatch.setattr(tc, "settings", replace(tc.settings, typhoon_api_key="test-key"))
    yield


def test_extract_json_object_plain():
    assert tc._extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_json_object_strips_markdown_fence():
    assert tc._extract_json_object('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_object_invalid_returns_empty_dict():
    assert tc._extract_json_object("not json at all") == {}


def test_extract_json_object_non_dict_returns_empty_dict():
    assert tc._extract_json_object("[1, 2, 3]") == {}


async def test_extract_passport_name_success():
    fake = _FakeOpenAI(content='{"full_name": "JOHN DOE"}')
    with patch.object(tc, "OpenAI", return_value=fake):
        name = await tc.extract_passport_name(_tiny_jpeg())
    assert name == "JOHN DOE"


async def test_extract_passport_name_missing_field_returns_empty_string():
    fake = _FakeOpenAI(content='{"something_else": "x"}')
    with patch.object(tc, "OpenAI", return_value=fake):
        name = await tc.extract_passport_name(_tiny_jpeg())
    assert name == ""


async def test_extract_ticket_fields_success():
    fake = _FakeOpenAI(content='{"flight_no": "TG123", "travel_date": "01 JAN 2026"}')
    with patch.object(tc, "OpenAI", return_value=fake):
        fields = await tc.extract_ticket_fields(_tiny_jpeg())
    assert fields == {"flight_no": "TG123", "travel_date": "01 JAN 2026"}


async def test_extract_accommodation_fields_success():
    fake = _FakeOpenAI(content='{"hotel_name": "ABC Hotel", "check_in_date": "01 JAN 2026"}')
    with patch.object(tc, "OpenAI", return_value=fake):
        fields = await tc.extract_accommodation_fields(_tiny_jpeg())
    assert fields == {"hotel_name": "ABC Hotel", "check_in_date": "01 JAN 2026"}


async def test_missing_api_key_raises_before_network_call(monkeypatch):
    monkeypatch.setattr(tc, "settings", replace(tc.settings, typhoon_api_key=""))
    with pytest.raises(tc.TyphoonOcrError):
        await tc.extract_passport_name(_tiny_jpeg())


async def test_openai_exception_wrapped_as_typhoon_error():
    fake = _FakeOpenAI(raise_on_create=RuntimeError("network down"))
    with patch.object(tc, "OpenAI", return_value=fake):
        with pytest.raises(tc.TyphoonOcrError):
            await tc.extract_passport_name(_tiny_jpeg())


async def test_request_shape_includes_prompt_and_image(monkeypatch):
    fake = _FakeOpenAI(content='{"full_name": "X"}')
    with patch.object(tc, "OpenAI", return_value=fake):
        await tc.extract_passport_name(_tiny_jpeg())

    kwargs = fake.chat.completions.last_kwargs
    assert kwargs["model"] == "typhoon-ocr"
    content = kwargs["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert "printed name field" in content[0]["text"]
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
