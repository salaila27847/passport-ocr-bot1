import pytest

from app import sheets as sheets_module


@pytest.fixture(autouse=True)
def _clear_row_cache():
    sheets_module._row_cache.clear()
    yield
    sheets_module._row_cache.clear()
