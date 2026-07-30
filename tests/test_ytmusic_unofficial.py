"""The opt-in, unofficial YouTube Music connector.

Its most important property is that it stays OFF: it speaks YouTube's internal
API, which can break without notice and whose use is very likely against
YouTube's terms. These tests pin that default hard, then check the mapping.
"""

from __future__ import annotations

import json

import pytest

from providers.base import AuthKind, PlaybackControl, ProviderError, TokenBundle
from providers.registry import all_providers, get_provider
from providers.ytmusic_unofficial import (
    UnofficialYouTubeMusicProvider,
    _int_or_unknown,
)

CREDENTIAL = json.dumps({"cookie": "SID=x", "user-agent": "Mozilla/5.0"})
TOKEN = TokenBundle(access_token=CREDENTIAL)


@pytest.fixture
def enabled(monkeypatch):
    """Turn the connector on the way an operator would have to."""
    monkeypatch.setenv("ENABLE_UNOFFICIAL_YTMUSIC", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    return UnofficialYouTubeMusicProvider()


class FakeYTMusic:
    """Stands in for the ytmusicapi client — no network, no real cookies."""

    def __init__(self, auth=None, **kw):
        if isinstance(auth, dict) and auth.get("cookie") == "REJECT":
            raise ValueError("cookie rejected")
        self.auth = auth

    def get_library_playlists(self, limit=None):
        return [
            {"playlistId": "PL1", "title": "Alles", "count": "1.482",
             "thumbnails": [{"url": "thumb"}]},
            {"playlistId": "LM", "title": "Liked Music", "count": "203"},
            {"title": "kaputt ohne id"},
        ]

    def get_playlist(self, playlistId, limit=None, **kw):
        return {"tracks": [
            {"videoId": "v1", "title": "Roygbiv",
             "artists": [{"name": "Boards of Canada"}],
             "album": {"name": "Music Has the Right"},
             "duration_seconds": 149, "isAvailable": True,
             "thumbnails": [{"url": "t1"}]},
            {"videoId": "v2", "title": "Weg", "artists": [],
             "duration_seconds": 0, "isAvailable": False},
        ]}

    def get_liked_songs(self, limit=None):
        return {"tracks": [
            {"videoId": "liked1", "title": "Teardrop",
             "artists": [{"name": "Massive Attack"}],
             "duration_seconds": 330, "isAvailable": True},
        ]}

    def get_history(self):
        return [
            {"videoId": "v3", "title": "Zuletzt", "played": "Today"},
            {"title": "kein videoId"},
            {"videoId": "v2", "title": "Davor", "played": "Yesterday"},
        ]

    def create_playlist(self, title, description, privacy_status="PRIVATE", **kw):
        return "PLnew"

    def add_playlist_items(self, playlistId, videoIds=None, **kw):
        self.added = (playlistId, list(videoIds or []))
        return "ok"


@pytest.fixture
def client(monkeypatch, enabled):
    """Install FakeYTMusic in place of the real import."""
    import sys
    import types

    made = {}

    def factory(auth=None, **kw):
        made["client"] = FakeYTMusic(auth, **kw)
        return made["client"]

    module = types.ModuleType("ytmusicapi")
    module.YTMusic = factory
    monkeypatch.setitem(sys.modules, "ytmusicapi", module)
    return made


# ---------------------------------------------------------------------------
# It stays off unless deliberately switched on
# ---------------------------------------------------------------------------

def test_it_is_off_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_UNOFFICIAL_YTMUSIC", raising=False)
    from app.config import get_settings
    get_settings.cache_clear()

    provider = UnofficialYouTubeMusicProvider()
    assert provider.is_configured() is False
    assert "ENABLE_UNOFFICIAL_YTMUSIC=true" in provider.missing_config()


def test_the_official_connector_is_still_the_default_youtube_path():
    ids = [p.capabilities.id for p in all_providers()]
    assert ids.index("youtube") < ids.index("ytmusic")
    from providers.youtube import YouTubeMusicProvider
    assert isinstance(get_provider("youtube", require_configured=False),
                      YouTubeMusicProvider)


def test_it_is_marked_experimental_and_says_why():
    caps = UnofficialYouTubeMusicProvider().capabilities
    assert caps.experimental is True
    joined = " ".join(caps.notes).lower()
    assert "inoffiziell" in joined
    assert "nutzungsbedingungen" in joined


def test_connecting_while_disabled_is_refused(monkeypatch):
    from providers.base import ProviderNotConfigured

    monkeypatch.delenv("ENABLE_UNOFFICIAL_YTMUSIC", raising=False)
    from app.config import get_settings
    get_settings.cache_clear()

    with pytest.raises(ProviderNotConfigured):
        import asyncio
        asyncio.run(UnofficialYouTubeMusicProvider().begin_auth(
            redirect_uri="http://x/cb", state="s"))


# ---------------------------------------------------------------------------
# What it buys, and how it is wired
# ---------------------------------------------------------------------------

def test_it_reaches_what_the_official_connector_cannot(enabled):
    """History sync is the whole point: a tracked deck with no tab open."""
    from providers.youtube import YouTubeMusicProvider

    assert enabled.capabilities.supports_history_sync is True
    assert enabled.capabilities.tracks_progress_without_tab is True
    assert YouTubeMusicProvider().capabilities.supports_history_sync is False


def test_it_uses_a_pasted_credential_not_a_redirect(enabled):
    assert enabled.capabilities.auth is AuthKind.PASTED
    assert enabled.capabilities.playback is PlaybackControl.WEB_PLAYER


def test_it_writes_in_batches_instead_of_one_costly_call_per_track(enabled):
    """No per-track quota here, unlike the Data API's 50 units each."""
    assert enabled.capabilities.write_batch_size > 1


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

async def test_a_non_json_paste_is_rejected_with_an_actionable_message(enabled, client):
    with pytest.raises(ProviderError, match="JSON"):
        await enabled.complete_browser_auth({"credential": "cookie: SID=x"})


async def test_an_empty_paste_is_rejected(enabled, client):
    with pytest.raises(ProviderError):
        await enabled.complete_browser_auth({"credential": "   "})


async def test_a_valid_paste_is_proven_before_it_is_stored(enabled, client):
    bundle = await enabled.complete_browser_auth({"credential": CREDENTIAL})
    assert bundle.access_token == CREDENTIAL
    # identify() ran, which means the credential was actually exercised.
    assert "client" in client


async def test_a_rejected_cookie_surfaces_as_an_auth_error(enabled, client):
    from providers.base import ProviderAuthError

    bad = json.dumps({"cookie": "REJECT"})
    with pytest.raises(ProviderAuthError, match="ytmusicapi browser"):
        await enabled.identify(TokenBundle(access_token=bad))


# ---------------------------------------------------------------------------
# Library mapping
# ---------------------------------------------------------------------------

async def test_library_playlists_are_mapped(enabled, client):
    playlists = await enabled.list_playlists(TOKEN)
    assert [p.id for p in playlists] == ["PL1", "LM"]     # the id-less row is dropped
    assert playlists[0].track_count == 1482               # "1.482" → 1482
    assert playlists[0].url.startswith("https://music.youtube.com/playlist")


async def test_liked_music_reads_through_its_own_endpoint(enabled, client):
    """"Liked Music" is not a normal playlist — the official API cannot see it."""
    pages = [p async for p in enabled.iter_playlist_tracks(TOKEN, "LM")]
    assert [t.id for page in pages for t in page] == ["liked1"]


async def test_playlist_tracks_are_mapped_with_availability(enabled, client):
    pages = [p async for p in enabled.iter_playlist_tracks(TOKEN, "PL1")]
    tracks = {t.id: t for page in pages for t in page}

    assert tracks["v1"].artist == "Boards of Canada"
    assert tracks["v1"].album == "Music Has the Right"
    assert tracks["v1"].duration_ms == 149_000
    assert tracks["v1"].is_valid
    # ytmusicapi reports availability directly; the Data API cannot.
    assert tracks["v2"].is_playable is False


async def test_history_becomes_played_tracks(enabled, client):
    played = await enabled.get_recently_played(TOKEN)
    assert [p.track_id for p in played] == ["v3", "v2"]   # the id-less row is dropped
    assert played[0].played_at == "Today"


async def test_creating_and_filling_a_playlist(enabled, client):
    created = await enabled.create_playlist(TOKEN, name="true-shuffle · Alles")
    assert created.id == "PLnew"

    await enabled.add_tracks(TOKEN, "PLnew", ["v1", "", "v2"])
    playlist_id, ids = client["client"].added
    assert playlist_id == "PLnew"
    assert ids == ["v1", "v2"]                            # blanks dropped


async def test_adding_nothing_makes_no_call(enabled, client):
    await enabled.add_tracks(TOKEN, "PLnew", [])
    assert not hasattr(client.get("client"), "added")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_count_parsing_survives_ytmusicapis_string_counts():
    assert _int_or_unknown("1.482") == 1482
    assert _int_or_unknown("203 songs") == 203
    assert _int_or_unknown(None) == -1
    assert _int_or_unknown("keine") == -1
