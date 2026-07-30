"""BASE_URL on Fly.

The redirect URI has to match Spotify's registration character for character,
and the app name is picked at launch — so a fly.toml placeholder that says
`true-shuffle-mvp` while the app is called something else is the single most
likely way to get stuck. Spotify's error for it ("INVALID_CLIENT: Invalid
redirect URI") does not say which side is wrong.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    from app.config import get_settings
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-not-a-default-value")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_on_fly_the_public_url_follows_from_the_app_name(monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "true-shuffle-mika")
    monkeypatch.delenv("BASE_URL", raising=False)
    from app.config import get_settings

    settings = get_settings()
    assert settings.base_url == "https://true-shuffle-mika.fly.dev"
    assert settings.redirect_uri("spotify") == (
        "https://true-shuffle-mika.fly.dev/auth/spotify/callback"
    )


def test_an_explicit_base_url_still_wins_so_a_custom_domain_works(monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "true-shuffle-mika")
    monkeypatch.setenv("BASE_URL", "https://app.true-shuffle.com")
    from app.config import get_settings

    assert get_settings().base_url == "https://app.true-shuffle.com"


def test_off_fly_nothing_changes(monkeypatch):
    monkeypatch.delenv("FLY_APP_NAME", raising=False)
    monkeypatch.delenv("BASE_URL", raising=False)
    from app.config import get_settings

    assert get_settings().base_url == "http://127.0.0.1:8000"
