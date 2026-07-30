"""Connector request paths, with the network stubbed out.

These exercise the code between "we have a token" and "we have Track objects" —
pagination, header construction, batching and error mapping.  A missing import
in this layer is invisible to the API tests, which never reach it.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from providers import http as provider_http
from providers.apple import AppleMusicProvider
from providers.base import ProviderAuthError, ProviderError, ProviderQuotaError, TokenBundle
from providers.spotify import SpotifyProvider
from providers.youtube import YouTubeMusicProvider

TOKEN = TokenBundle(access_token="test-token", refresh_token="refresh")


class StubHTTP:
    """Replaces providers.http.request and records every call."""

    def __init__(self, responses: List[Any]) -> None:
        self.responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    async def __call__(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        if not self.responses:
            return None
        payload = self.responses.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return payload


@pytest.fixture
def stub(monkeypatch):
    def install(responses):
        s = StubHTTP(responses)
        monkeypatch.setattr(provider_http, "request", s)
        for module in ("providers.spotify", "providers.apple", "providers.youtube"):
            monkeypatch.setattr(f"{module}.http.request", s, raising=False)
        return s
    return install


@pytest.fixture
def apple(monkeypatch):
    """An Apple provider with a real signing key so tokens can be minted."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    pem = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", pem)
    from app.config import get_settings
    get_settings.cache_clear()
    return AppleMusicProvider()


# ---------------------------------------------------------------------------
# Spotify
# ---------------------------------------------------------------------------

async def test_spotify_paginates_playlists(stub):
    s = stub([
        {"items": [{"id": "a", "name": "A", "tracks": {"total": 3}}], "next": "more"},
        {"items": [{"id": "b", "name": "B", "tracks": {"total": 5}}], "next": None},
    ])
    playlists = await SpotifyProvider().list_playlists(TOKEN)
    assert [p.id for p in playlists] == ["a", "b"]
    assert s.calls[1]["params"]["offset"] == 50


async def test_spotify_paginates_tracks(stub):
    stub([
        {"items": [{"track": {"id": f"t{i}", "type": "track"}} for i in range(2)],
         "next": "more"},
        {"items": [{"track": {"id": "t9", "type": "track"}}], "next": None},
    ])
    pages = [page async for page in
             SpotifyProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert [t.id for page in pages for t in page] == ["t0", "t1", "t9"]


async def test_spotify_sends_a_bearer_token(stub):
    s = stub([{"items": [], "next": None}])
    await SpotifyProvider().list_playlists(TOKEN)
    assert s.calls[0]["headers"]["Authorization"] == "Bearer test-token"


async def test_spotify_writes_tracks_in_batches_of_100(stub):
    s = stub([None, None])
    await SpotifyProvider().add_tracks(TOKEN, "pl1", [f"t{i}" for i in range(150)])
    assert len(s.calls) == 2
    assert len(s.calls[0]["json_body"]["uris"]) == 100
    assert len(s.calls[1]["json_body"]["uris"]) == 50
    assert s.calls[0]["json_body"]["uris"][0].startswith("spotify:track:")


async def test_spotify_resolves_track_metadata(stub):
    stub([{"tracks": [{"id": "t1", "name": "Song", "type": "track",
                       "artists": [{"name": "A"}], "album": {"name": "Al"}}]}])
    found = await SpotifyProvider().resolve_tracks(TOKEN, ["t1"])
    assert found["t1"].name == "Song"


async def test_spotify_playback_state_is_normalised(stub):
    stub([{
        "is_playing": True, "progress_ms": 42000,
        "item": {"id": "t7", "duration_ms": 180000},
        "device": {"id": "dev1", "name": "Phone"},
    }])
    state = await SpotifyProvider().get_playback_state(TOKEN)
    assert state.track_id == "t7"
    assert state.remaining_ms == 138000
    assert state.is_idle is False


async def test_spotify_reports_an_empty_player_as_idle(stub):
    stub([None])
    assert (await SpotifyProvider().get_playback_state(TOKEN)).is_idle is True


async def test_spotify_play_sends_a_track_uri(stub):
    s = stub([None])
    await SpotifyProvider().play(TOKEN, track_id="t1", device_id="dev1")
    assert s.calls[0]["json_body"]["uris"] == ["spotify:track:t1"]
    assert s.calls[0]["params"]["device_id"] == "dev1"


# ---------------------------------------------------------------------------
# Apple Music
# ---------------------------------------------------------------------------

async def test_apple_sends_both_required_headers(stub, apple):
    s = stub([{"data": []}])
    await apple.list_playlists(TOKEN)
    headers = s.calls[0]["headers"]
    assert headers["Authorization"].startswith("Bearer ")
    assert headers["Music-User-Token"] == "test-token"


async def test_apple_paginates_library_playlists(stub, apple):
    stub([
        {"data": [{"id": "p.1", "attributes": {"name": "A"}}], "next": "/next"},
        {"data": [{"id": "p.2", "attributes": {"name": "B"}}]},
    ])
    playlists = await apple.list_playlists(TOKEN)
    assert [p.id for p in playlists] == ["p.1", "p.2"]


async def test_apple_creates_a_library_playlist(stub, apple):
    s = stub([{"data": [{"id": "p.new", "attributes": {"name": "true-shuffle · X"}}]}])
    created = await apple.create_playlist(TOKEN, name="true-shuffle · X")
    assert created.id == "p.new"
    assert s.calls[0]["json_body"]["attributes"]["name"] == "true-shuffle · X"


async def test_apple_adds_tracks_as_song_relationships(stub, apple):
    s = stub([None])
    await apple.add_tracks(TOKEN, "p.1", ["111", "222"])
    assert s.calls[0]["json_body"]["data"] == [
        {"id": "111", "type": "songs"}, {"id": "222", "type": "songs"},
    ]


async def test_apple_resolve_tracks_uses_the_storefront(stub, apple):
    """Regression: this path once raised NameError before it made a request."""
    s = stub([
        {"data": [{"id": "de", "attributes": {"name": "Germany"}}]},   # storefront
        {"data": [{"id": "111", "attributes": {"name": "Song", "artistName": "A"}}]},
    ])
    found = await apple.resolve_tracks(TOKEN, ["111"])
    assert found["111"].name == "Song"
    assert "/catalog/de/songs" in s.calls[1]["url"]


async def test_apple_resolve_tracks_falls_back_when_storefront_is_unknown(stub, apple):
    s = stub([
        ProviderError("apple: storefront unavailable"),
        {"data": [{"id": "111", "attributes": {"name": "Song"}}]},
    ])
    found = await apple.resolve_tracks(TOKEN, ["111"])
    assert found["111"].name == "Song"
    assert "/catalog/us/songs" in s.calls[1]["url"]


async def test_apple_identify_returns_the_storefront(stub, apple):
    stub([{"data": [{"id": "de", "attributes": {"name": "Germany"}}]}])
    identity = await apple.identify(TOKEN)
    assert identity.market == "de"


# ---------------------------------------------------------------------------
# YouTube Music
# ---------------------------------------------------------------------------

async def test_youtube_paginates_with_page_tokens(stub):
    s = stub([
        {"items": [{"id": "pl1", "snippet": {"title": "A"},
                    "contentDetails": {"itemCount": 3}}],
         "nextPageToken": "page2"},
        {"items": [{"id": "pl2", "snippet": {"title": "B"},
                    "contentDetails": {"itemCount": 4}}]},
    ])
    playlists = await YouTubeMusicProvider().list_playlists(TOKEN)
    assert [p.id for p in playlists] == ["pl1", "pl2"]
    assert s.calls[1]["params"]["pageToken"] == "page2"


async def test_youtube_enriches_tracks_with_duration_and_embeddability(stub):
    stub([
        {"items": [
            {"snippet": {"title": "Song", "resourceId": {"videoId": "v1"}},
             "contentDetails": {"videoId": "v1"}, "status": {"privacyStatus": "public"}},
            {"snippet": {"title": "Blocked", "resourceId": {"videoId": "v2"}},
             "contentDetails": {"videoId": "v2"}, "status": {"privacyStatus": "public"}},
        ]},
        {"items": [
            {"id": "v1", "contentDetails": {"duration": "PT3M20S"},
             "status": {"embeddable": True}},
            {"id": "v2", "contentDetails": {"duration": "PT4M"},
             "status": {"embeddable": False}},
        ]},
    ])
    pages = [p async for p in
             YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    tracks = {t.id: t for page in pages for t in page}

    assert tracks["v1"].duration_ms == 200_000
    assert tracks["v1"].is_valid
    # A video its owner blocked from embedding cannot be played by our player.
    assert tracks["v2"].is_playable is False


async def test_youtube_marks_a_video_the_api_did_not_return_as_unplayable(stub):
    """Requested but missing means removed or region-blocked — not silently ok."""
    stub([
        {"items": [{"snippet": {"title": "Song", "resourceId": {"videoId": "gone"}},
                    "contentDetails": {"videoId": "gone"},
                    "status": {"privacyStatus": "public"}}]},
        {"items": []},
    ])
    pages = [p async for p in
             YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert pages[0][0].is_playable is False


async def test_youtube_inserts_playlist_items_one_at_a_time(stub):
    s = stub([None, None, None])
    await YouTubeMusicProvider().add_tracks(TOKEN, "pl1", ["v1", "v2", "v3"])
    assert len(s.calls) == 3
    assert s.calls[0]["json_body"]["snippet"]["resourceId"]["videoId"] == "v1"


async def test_youtube_identify_requires_a_channel(stub):
    stub([{"items": []}])
    with pytest.raises(ProviderError, match="no YouTube channel"):
        await YouTubeMusicProvider().identify(TOKEN)


# ---------------------------------------------------------------------------
# Shared HTTP behaviour
# ---------------------------------------------------------------------------

def test_rate_limit_headers_are_parsed():
    import httpx

    resp = httpx.Response(429, headers={"Retry-After": "7"})
    assert provider_http._retry_after(resp) == 7
    assert provider_http._retry_after(httpx.Response(429)) == 2
    assert provider_http._retry_after(
        httpx.Response(429, headers={"Retry-After": "soon"})) == 2


def test_401_becomes_an_auth_error_and_403_does_not():
    import httpx

    assert isinstance(
        provider_http._auth_error("spotify", httpx.Response(401, text="bad token")),
        ProviderAuthError,
    )
    forbidden = provider_http._auth_error(
        "spotify", httpx.Response(403, text="Player command failed: Premium required")
    )
    assert isinstance(forbidden, ProviderError)
    assert not isinstance(forbidden, ProviderAuthError)
    assert "Premium" in str(forbidden)


def test_a_403_about_quota_is_classified_as_a_quota_error():
    import httpx

    error = provider_http._auth_error(
        "youtube", httpx.Response(403, text="quotaExceeded")
    )
    assert isinstance(error, ProviderQuotaError)


def test_the_sequential_lock_is_shared_per_account():
    a = provider_http.sequential_lock("spotify:1")
    assert provider_http.sequential_lock("spotify:1") is a
    assert provider_http.sequential_lock("spotify:2") is not a
