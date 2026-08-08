from dataclasses import replace

import pytest
from fastapi import HTTPException

from app import auth


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(auth.settings, google_oauth_client_id="client-id-123"))
    yield


def test_is_allowed_email_exact_list(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(auth.settings, allowed_staff_emails="a@x.com, b@x.com"))
    assert auth._is_allowed_email("A@x.com") is True  # case-insensitive
    assert auth._is_allowed_email("c@x.com") is False


def test_is_allowed_email_domain(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(auth.settings, allowed_staff_domain="company.com"))
    assert auth._is_allowed_email("someone@company.com") is True
    assert auth._is_allowed_email("someone@othercompany.com") is False


def test_is_allowed_email_denies_by_default_when_unconfigured(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(auth.settings, allowed_staff_emails="", allowed_staff_domain=""))
    assert auth._is_allowed_email("anyone@anywhere.com") is False


async def test_require_staff_user_no_header_401():
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="")
    assert exc_info.value.status_code == 401


async def test_require_staff_user_malformed_header_401():
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="not-a-bearer-token")
    assert exc_info.value.status_code == 401


async def test_require_staff_user_missing_client_id_500(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(auth.settings, google_oauth_client_id=""))
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="Bearer sometoken")
    assert exc_info.value.status_code == 500


async def test_require_staff_user_invalid_token_401(monkeypatch):
    def _raise(token):
        raise ValueError("bad token")

    monkeypatch.setattr(auth, "_verify_token_sync", _raise)
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="Bearer badtoken")
    assert exc_info.value.status_code == 401


async def test_require_staff_user_unverified_email_401(monkeypatch):
    monkeypatch.setattr(
        auth, "_verify_token_sync",
        lambda token: {"email": "x@y.com", "email_verified": False, "name": "X"},
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="Bearer token")
    assert exc_info.value.status_code == 401


async def test_require_staff_user_not_in_allowlist_403(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(
        auth.settings, google_oauth_client_id="client-id-123", allowed_staff_emails="only@allowed.com",
    ))
    monkeypatch.setattr(
        auth, "_verify_token_sync",
        lambda token: {"email": "someone@else.com", "email_verified": True, "name": "Someone"},
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_staff_user(authorization="Bearer token")
    assert exc_info.value.status_code == 403


async def test_require_staff_user_success(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(
        auth.settings, google_oauth_client_id="client-id-123", allowed_staff_emails="staff@company.com",
    ))
    monkeypatch.setattr(
        auth, "_verify_token_sync",
        lambda token: {"email": "staff@company.com", "email_verified": True, "name": "Staff Person"},
    )
    result = await auth.require_staff_user(authorization="Bearer validtoken")
    assert result.email == "staff@company.com"
    assert result.name == "Staff Person"


async def test_require_staff_user_falls_back_to_email_when_name_missing(monkeypatch):
    monkeypatch.setattr(auth, "settings", replace(
        auth.settings, google_oauth_client_id="client-id-123", allowed_staff_emails="staff@company.com",
    ))
    monkeypatch.setattr(
        auth, "_verify_token_sync",
        lambda token: {"email": "staff@company.com", "email_verified": True},
    )
    result = await auth.require_staff_user(authorization="Bearer validtoken")
    assert result.name == "staff@company.com"
