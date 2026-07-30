"""Connector request paths, with the network stubbed out.

These exercise the code between "we have a token" and "we have Track objects" —
pagination, header construction, batching and error mapping.  A missing import
in this layer is invisible to the API tests, which never reach it.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from core.models import UNKNOWN_TRACK_COUNT
from providers import http as provider_http
from providers import spotify
from providers.apple import AppleMusicProvider
from providers.base import (
    ProviderAuthError,
    ProviderContentUnavailable,
    ProviderError,
    ProviderPaidTierRequired,
    ProviderQuotaError,
    TokenBundle,
)
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


@pytest.fixture(autouse=True)
def _fresh_connector_state():
    """Reset the two caches the Spotify connector keeps between calls.

    Both exist because single-item lookups replaced batch reads in February
    2026; both would otherwise leak one test's answers into the next.
    """
    TOKEN.extra.clear()
    spotify._cache_clear()
    yield
    TOKEN.extra.clear()
    spotify._cache_clear()


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

#: What ``GET /me`` still answers for a Development Mode client created after
#: February 2026: no ``country``, no ``product``, no ``email``.
ME = {"id": "me-1", "display_name": "Listener"}


def _playlist(pid: str, *, total: int | None = 3, owner: str = "me-1"):
    """A playlist object in the post-February-2026 shape.

    ``total=None`` models the case that broke the library: Spotify lists the
    playlist but omits the whole ``items`` block because the user does not own
    it.
    """
    p = {"id": pid, "name": pid.upper(), "owner": {"id": owner}}
    if total is not None:
        p["items"] = {"total": total}
    return p


async def test_spotify_paginates_playlists(stub):
    s = stub([
        ME,
        {"items": [_playlist("a", total=3)], "next": "more"},
        {"items": [_playlist("b", total=5)], "next": None},
    ])
    playlists = await SpotifyProvider().list_playlists(TOKEN)
    assert [p.id for p in playlists] == ["a", "b"]
    # calls[0] is the /me lookup that establishes ownership.
    assert s.calls[2]["params"]["offset"] == 50


async def test_spotify_reads_the_track_count_from_items_not_tracks(stub):
    """The February 2026 rename is why every playlist reported zero titles."""
    stub([
        ME,
        {"items": [_playlist("a", total=42)], "next": None},
    ])
    playlists = await SpotifyProvider().list_playlists(TOKEN)
    assert playlists[0].track_count == 42
    assert playlists[0].readable is True


async def test_spotify_reports_an_absent_item_count_as_unknown_not_zero(stub):
    """A missing count is "we do not know", and must never render as 0 Titel."""
    stub([
        ME,
        {"items": [_playlist("a", total=None)], "next": None},
    ])
    playlists = await SpotifyProvider().list_playlists(TOKEN)
    assert playlists[0].track_count == UNKNOWN_TRACK_COUNT
    assert playlists[0].track_count < 0


async def test_spotify_marks_someone_elses_playlist_unreadable(stub):
    """Editorial and followed playlists still list; their contents do not."""
    stub([
        ME,
        {"items": [_playlist("mine", owner="me-1"),
                   _playlist("radio", owner="spotify")], "next": None},
    ])
    mine, radio = await SpotifyProvider().list_playlists(TOKEN)
    assert mine.readable is True
    assert mine.unreadable_reason == ""
    assert radio.readable is False
    assert "Februar 2026" in radio.unreadable_reason
    # Nothing may offer a write action on a playlist we cannot even read.
    assert radio.editable is False


async def test_spotify_treats_a_collaborative_playlist_as_readable(stub):
    stub([
        ME,
        {"items": [dict(_playlist("shared", owner="someone-else"),
                        collaborative=True)], "next": None},
    ])
    playlists = await SpotifyProvider().list_playlists(TOKEN)
    assert playlists[0].readable is True


async def test_spotify_reads_playlist_items_from_the_new_endpoint(stub):
    s = stub([
        {"items": [{"item": {"id": f"t{i}", "type": "track"}} for i in range(2)],
         "next": "more"},
        {"items": [{"item": {"id": "t9", "type": "track"}}], "next": None},
    ])
    provider = SpotifyProvider()
    pages = [page async for page in provider.iter_playlist_tracks(TOKEN, "pl1")]
    assert [t.id for page in pages for t in page] == ["t0", "t1", "t9"]

    # The endpoint rename is the whole point — pin the URL, not just the shape.
    assert s.calls[0]["url"].endswith("/playlists/pl1/items")
    assert not any(c["url"].endswith("/playlists/pl1/tracks") for c in s.calls)
    assert s.calls[0]["params"]["limit"] <= 50


def _http_error(status: int, message: str) -> ProviderError:
    """A connector error carrying the status the service actually sent."""
    exc = ProviderError(message)
    exc.http_status = status
    return exc


async def test_spotify_explains_a_playlist_it_may_not_read(stub):
    """A 403 on the items endpoint means "not yours", not "empty"."""
    stub([_http_error(403, "spotify: refused (403) — Forbidden")])
    provider = SpotifyProvider()
    with pytest.raises(ProviderContentUnavailable, match="Februar 2026"):
        [page async for page in provider.iter_playlist_tracks(TOKEN, "radio")]


@pytest.mark.parametrize("status,label", [(404, "gone"), (503, "upstream down")])
async def test_spotify_only_calls_a_403_a_permission_problem(stub, status, label):
    """A missing playlist and an outage must each surface as themselves.

    Reporting either as "not your playlist" would send someone hunting for a
    permission problem they do not have.
    """
    stub([_http_error(status, f"spotify: HTTP {status} — {label}")])
    provider = SpotifyProvider()
    with pytest.raises(ProviderError) as caught:
        [page async for page in provider.iter_playlist_tracks(TOKEN, "pl1")]
    assert not isinstance(caught.value, ProviderContentUnavailable)


@pytest.mark.parametrize("kind", [ProviderQuotaError, ProviderPaidTierRequired,
                                  ProviderAuthError])
async def test_spotify_keeps_the_truer_meaning_of_an_overloaded_403(stub, kind):
    """403 says several different things; the specific ones must win.

    An exhausted quota reported as "this playlist is not yours" would send
    someone copying playlists to fix a problem copying cannot fix.
    """
    exc = kind("spotify: something more specific")
    exc.http_status = 403
    stub([exc])
    provider = SpotifyProvider()
    with pytest.raises(kind) as caught:
        [page async for page in provider.iter_playlist_tracks(TOKEN, "pl1")]
    assert not isinstance(caught.value, ProviderContentUnavailable)


def test_the_service_status_travels_on_the_error(monkeypatch):
    """``_is_content_refusal`` reads this, so it must actually get set."""
    import httpx

    tagged = provider_http._tagged(ProviderError("boom"), 403)
    assert tagged.http_status == 403
    # And a freshly built error has no status until one is attached.
    assert ProviderError("boom").http_status is None
    assert provider_http._auth_error("spotify", httpx.Response(403)).http_status is None


async def test_spotify_does_not_call_an_empty_playlist_unreadable(stub):
    """An empty playlist you own is empty — a different fact, a different answer.

    Conflating the two would tell someone their own empty playlist belongs to
    somebody else.  Ownership is settled before the read, on the PlaylistRef.
    """
    stub([{"items": [], "next": None}])
    provider = SpotifyProvider()
    pages = [page async for page in provider.iter_playlist_tracks(TOKEN, "mine")]
    assert pages == []


async def test_spotify_sends_a_bearer_token(stub):
    s = stub([ME, {"items": [], "next": None}])
    await SpotifyProvider().list_playlists(TOKEN)
    assert s.calls[0]["headers"]["Authorization"] == "Bearer test-token"


async def test_spotify_identify_no_longer_reports_market_or_tier(stub):
    """``country`` and ``product`` left GET /me; empty is correct, not a bug."""
    stub([ME])
    identity = await SpotifyProvider().identify(TokenBundle(access_token="t"))
    assert identity.provider_user_id == "me-1"
    assert identity.display_name == "Listener"
    assert identity.market == ""
    assert identity.product_tier == ""


async def test_spotify_writes_tracks_in_batches_of_100(stub):
    s = stub([None, None])
    await SpotifyProvider().add_tracks(TOKEN, "pl1", [f"t{i}" for i in range(150)])
    assert len(s.calls) == 2
    assert len(s.calls[0]["json_body"]["uris"]) == 100
    assert len(s.calls[1]["json_body"]["uris"]) == 50
    assert s.calls[0]["json_body"]["uris"][0].startswith("spotify:track:")
    # POST /playlists/{id}/tracks was removed in February 2026.
    assert s.calls[0]["url"].endswith("/playlists/pl1/items")


async def test_spotify_creates_a_playlist_on_me_playlists(stub):
    """POST /users/{id}/playlists is gone, and with it the identify() round trip."""
    s = stub([{"id": "new", "name": "true-shuffle · X",
               "external_urls": {"spotify": "https://open.spotify.com/playlist/new"}}])
    created = await SpotifyProvider().create_playlist(
        TokenBundle(access_token="t"), name="true-shuffle · X", description="d"
    )
    assert created.id == "new"
    assert len(s.calls) == 1
    assert s.calls[0]["url"].endswith("/me/playlists")
    assert "/users/" not in s.calls[0]["url"]
    assert s.calls[0]["json_body"] == {
        "name": "true-shuffle · X", "public": False, "description": "d",
    }


async def test_spotify_resolves_track_metadata_one_request_per_id(stub):
    """Batch reads were removed; ``GET /tracks/{id}`` is all that is left."""
    spotify._cache_clear()
    s = stub([
        {"id": "t1", "name": "Song", "type": "track",
         "artists": [{"name": "A"}], "album": {"name": "Al"}},
        {"id": "t2", "name": "Other", "type": "track", "artists": []},
    ])
    found = await SpotifyProvider().resolve_tracks(TOKEN, ["t1", "t2"])
    assert found["t1"].name == "Song"
    assert found["t2"].name == "Other"
    assert [c["url"].rsplit("/", 1)[-1] for c in s.calls] == ["t1", "t2"]
    assert all("ids" not in (c.get("params") or {}) for c in s.calls)


async def test_spotify_caches_resolved_tracks(stub):
    """The player asks for the same window every few seconds."""
    spotify._cache_clear()
    s = stub([{"id": "t1", "name": "Song", "type": "track"}])
    provider = SpotifyProvider()
    await provider.resolve_tracks(TOKEN, ["t1"])
    again = await provider.resolve_tracks(TOKEN, ["t1"])
    assert again["t1"].name == "Song"
    assert len(s.calls) == 1


async def test_spotify_resolve_survives_a_single_missing_track(stub):
    """One unavailable title is a blank line, not a broken deck."""
    stub([
        ProviderError("spotify: HTTP 404 — not found"),
        {"id": "t2", "name": "Other", "type": "track"},
    ])
    found = await SpotifyProvider().resolve_tracks(TOKEN, ["t1", "t2"])
    assert "t1" not in found
    assert found["t2"].name == "Other"


async def test_spotify_stops_resolving_once_the_quota_is_gone(stub):
    """Nine more single-track requests cannot succeed and only dig deeper."""
    s = stub([
        {"id": "t1", "name": "Song", "type": "track"},
        ProviderQuotaError("spotify: quota exhausted (QUOTA_EXCEEDED)"),
        {"id": "t3", "name": "Never asked for", "type": "track"},
    ])
    found = await SpotifyProvider().resolve_tracks(TOKEN, ["t1", "t2", "t3"])
    # What was already resolved is kept — a partial "up next" beats a blank one.
    assert found["t1"].name == "Song"
    assert "t2" not in found and "t3" not in found
    assert len(s.calls) == 2


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


def test_a_premium_refusal_is_its_own_error_class():
    """The only way left to learn a Spotify account has no Premium.

    ``product`` left GET /me in February 2026, so nothing can gate Live Mode up
    front — the player's refusal has to carry the meaning instead.
    """
    import httpx

    for resp in (
        httpx.Response(403, text="Player command failed: Premium required"),
        httpx.Response(403, json={"error": {"status": 403, "message": "Forbidden",
                                            "reason": "PREMIUM_REQUIRED"}}),
    ):
        error = provider_http._auth_error("spotify", resp)
        assert isinstance(error, ProviderPaidTierRequired)
        # It is not a credentials problem — reconnecting would not help.
        assert not isinstance(error, ProviderAuthError)


def test_the_paid_tier_refusal_reaches_the_listener_in_german():
    from providers.base import user_message

    text = user_message(ProviderPaidTierRequired("spotify: no premium — 403"))
    assert "Handoff" in text
    assert "Abo" in text


def test_a_quota_reason_is_read_out_of_the_error_body():
    """Spotify's July 2026 shape for "your allowance is gone"."""
    import httpx

    resp = httpx.Response(429, json={"error": {"status": 429,
                                               "message": "Too many requests",
                                               "reason": "QUOTA_EXCEEDED"}})
    assert provider_http.error_reason(resp) == "QUOTA_EXCEEDED"
    # A plain rate limit carries no reason, and must stay retryable.
    assert provider_http.error_reason(httpx.Response(429, text="slow down")) == ""
    assert provider_http.error_reason(httpx.Response(429, text="")) == ""


async def test_quota_exceeded_is_not_retried(monkeypatch):
    """Waiting cannot refill an exhausted allowance, so do not spend three tries."""
    import httpx

    attempts = 0

    class _Client:
        def __init__(self, *a, **k): pass
        async def request(self, *a, **k):
            nonlocal attempts
            attempts += 1
            return httpx.Response(429, json={"error": {"status": 429,
                                                       "message": "Too many requests",
                                                       "reason": "QUOTA_EXCEEDED"}})
        async def aclose(self): pass

    monkeypatch.setattr(provider_http.httpx, "AsyncClient", _Client)
    with pytest.raises(ProviderQuotaError, match="QUOTA_EXCEEDED"):
        await provider_http.request("GET", "https://api.spotify.com/v1/me",
                                    provider="spotify")
    assert attempts == 1


async def test_a_plain_rate_limit_still_backs_off_and_retries(monkeypatch):
    import httpx

    responses = [
        httpx.Response(429, headers={"Retry-After": "1"}),
        httpx.Response(200, json={"ok": True}),
    ]

    class _Client:
        def __init__(self, *a, **k): pass
        async def request(self, *a, **k):
            return responses.pop(0)
        async def aclose(self): pass

    slept: list[float] = []

    async def _sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(provider_http.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(provider_http.asyncio, "sleep", _sleep)
    payload = await provider_http.request("GET", "https://api.spotify.com/v1/me",
                                          provider="spotify")
    assert payload == {"ok": True}
    assert slept == [1]


async def test_a_real_403_reaches_the_connector_carrying_its_status(monkeypatch):
    """The seam: http.request tags the error, the connector branches on the tag.

    Tested end to end because the two halves live in different modules and a
    unit test of either would keep passing if the other stopped cooperating.
    """
    import httpx

    class _Client:
        def __init__(self, *a, **k): pass
        async def request(self, *a, **k):
            return httpx.Response(403, text="Forbidden")
        async def aclose(self): pass

    monkeypatch.setattr(provider_http.httpx, "AsyncClient", _Client)
    with pytest.raises(ProviderError) as caught:
        await provider_http.request(
            "GET", "https://api.spotify.com/v1/playlists/radio/items",
            provider="spotify",
        )
    assert caught.value.http_status == 403
    assert SpotifyProvider._is_content_refusal(caught.value)


async def test_the_throttle_spaces_requests_on_the_same_key(monkeypatch):
    """Batch reads are gone; the spacer is what stops the replacement burst."""
    slept: list[float] = []

    async def _sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(provider_http.asyncio, "sleep", _sleep)
    provider_http.set_throttle("test:key", 0.5)
    provider_http._throttle_last.pop("test:key", None)
    try:
        await provider_http.throttle("test:key")   # first one goes straight out
        await provider_http.throttle("test:key")   # second one has to wait
    finally:
        provider_http.set_throttle("test:key", 0.0)
        provider_http._throttle_last.pop("test:key", None)

    assert len(slept) == 1
    assert 0 < slept[0] <= 0.5


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


# ---------------------------------------------------------------------------
# YouTube: is this actually music?
# ---------------------------------------------------------------------------

def _yt_page(video_id: str, title: str = "Song", channel: str = "Artist"):
    return {"items": [{
        "snippet": {"title": title, "videoOwnerChannelTitle": channel,
                    "resourceId": {"videoId": video_id}},
        "contentDetails": {"videoId": video_id},
        "status": {"privacyStatus": "public"},
    }]}


async def test_youtube_keeps_music_category_entries(stub):
    stub([
        _yt_page("v1"),
        {"items": [{"id": "v1", "snippet": {"categoryId": "10", "channelTitle": "Artist"},
                    "contentDetails": {"duration": "PT3M"},
                    "status": {"embeddable": True}}]},
    ])
    pages = [p async for p in YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert pages[0][0].is_valid


async def test_youtube_leaves_non_music_out_of_the_deck(stub):
    """A playlist can hold a lecture or a trailer; a music deck should not."""
    from core.models import SkipReason

    stub([
        _yt_page("v1", title="Two hour podcast", channel="Some Channel"),
        {"items": [{"id": "v1", "snippet": {"categoryId": "22", "channelTitle": "Some Channel"},
                    "contentDetails": {"duration": "PT2H"},
                    "status": {"embeddable": True}}]},
    ])
    pages = [p async for p in YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    track = pages[0][0]
    assert not track.is_valid
    assert track.invalid_reason() is SkipReason.NOT_MUSIC


async def test_youtube_topic_channels_count_as_music_whatever_the_category(stub):
    """"<Artist> - Topic" is YouTube Music's own catalogue upload."""
    stub([
        _yt_page("v1", channel="Boards of Canada - Topic"),
        {"items": [{"id": "v1", "snippet": {"categoryId": "24",
                                            "channelTitle": "Boards of Canada - Topic"},
                    "contentDetails": {"duration": "PT2M29S"},
                    "status": {"embeddable": True}}]},
    ])
    pages = [p async for p in YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert pages[0][0].is_valid


async def test_youtube_strips_the_topic_suffix_from_the_artist(stub):
    stub([
        _yt_page("v1", channel="Aphex Twin - Topic"),
        {"items": [{"id": "v1", "snippet": {"categoryId": "10",
                                            "channelTitle": "Aphex Twin - Topic"},
                    "contentDetails": {"duration": "PT6M6S"},
                    "status": {"embeddable": True}}]},
    ])
    pages = [p async for p in YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert pages[0][0].artist == "Aphex Twin"


async def test_youtube_asks_for_the_snippet_so_category_is_available(stub):
    """videos.list costs one unit whatever the parts, so snippet is free."""
    s = stub([
        _yt_page("v1"),
        {"items": [{"id": "v1", "snippet": {"categoryId": "10"},
                    "contentDetails": {"duration": "PT3M"},
                    "status": {"embeddable": True}}]},
    ])
    [p async for p in YouTubeMusicProvider().iter_playlist_tracks(TOKEN, "pl1")]
    assert "snippet" in s.calls[1]["params"]["part"]
