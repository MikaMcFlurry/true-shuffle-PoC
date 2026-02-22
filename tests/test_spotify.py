"""Tests for Spotify API helpers (app/spotify.py).

All HTTP calls are mocked via httpx transport.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.spotify import (
    add_tracks_batch,
    create_playlist,
    get_current_user_id,
    get_my_playlists,
    get_playlist,
    get_playlist_tracks,
)


# ---------------------------------------------------------------------------
# Helpers for mocking httpx
# ---------------------------------------------------------------------------

class MockTransport(httpx.AsyncBaseTransport):
    """Programmable transport returning canned responses per URL path."""

    def __init__(self, routes: dict[str, list]):
        # routes: {path_prefix: [response_dict, ...]}
        self._routes = routes
        self._call_log: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request):
        self._call_log.append(request)
        path = request.url.path
        for prefix, responses in self._routes.items():
            if path.startswith(prefix):
                body = responses.pop(0) if responses else {}
                return httpx.Response(200, json=body)
        return httpx.Response(404, json={"error": "not found"})


def _make_client(routes):
    transport = MockTransport(routes)
    return httpx.AsyncClient(transport=transport), transport


# ---------------------------------------------------------------------------
# get_my_playlists
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_my_playlists_single_page(monkeypatch):
    page = {
        "items": [
            {"id": "p1", "name": "Rock", "tracks": {"total": 42},
             "owner": {"display_name": "me"}},
            {"id": "p2", "name": "Pop", "tracks": {"total": 10},
             "owner": {"display_name": "me"}},
        ],
        "next": None,
    }
    client, _ = _make_client({"/v1/me/playlists": [page]})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    result = await get_my_playlists("fake-token")
    assert len(result) == 2
    assert result[0]["id"] == "p1"
    assert result[0]["total_tracks"] == 42


# ---------------------------------------------------------------------------
# get_playlist_tracks — paging + filtering
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_playlist_tracks_filters_and_dedupes(monkeypatch):
    page1 = {
        "items": [
            {"track": {"uri": "spotify:track:a", "type": "track", "is_local": False, "name": "A"}},
            {"track": {"uri": "spotify:track:b", "type": "track", "is_local": False, "name": "B"}},
            {"track": {"uri": "spotify:track:a", "type": "track", "is_local": False, "name": "A dup"}},  # duplicate
            {"track": {"uri": "spotify:local:x", "type": "track", "is_local": True, "name": "Local"}},  # local
            {"track": None},  # unavailable
            {"track": {"uri": "spotify:episode:e", "type": "episode", "is_local": False, "name": "Ep"}},  # episode
        ],
        "next": None,
    }
    client, _ = _make_client({"/v1/playlists/": [page1]})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    uris, excluded = await get_playlist_tracks("fake-token", "test-pl")
    assert uris == ["spotify:track:a", "spotify:track:b"]
    assert len(excluded) == 4  # dup + local + unavailable + episode
    reasons = {e["reason"] for e in excluded}
    assert "duplicate" in reasons
    assert "local_file" in reasons
    assert "unavailable" in reasons
    assert any(r.startswith("type:") for r in reasons)


@pytest.mark.asyncio
async def test_get_playlist_tracks_paging(monkeypatch):
    """Three pages of tracks should all be collected."""
    def make_page(start, count, has_next):
        items = [
            {"track": {"uri": f"spotify:track:{start+i}", "type": "track", "is_local": False, "name": f"T{start+i}"}}
            for i in range(count)
        ]
        return {"items": items, "next": "http://next" if has_next else None}

    pages = [make_page(0, 100, True), make_page(100, 100, True), make_page(200, 50, False)]
    client, _ = _make_client({"/v1/playlists/": pages})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    uris, excluded = await get_playlist_tracks("fake-token", "big-pl")
    assert len(uris) == 250
    assert len(excluded) == 0


# ---------------------------------------------------------------------------
# add_tracks_batch — batching
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_add_tracks_batch_chunks(monkeypatch):
    """250 tracks should produce 3 API calls (100 + 100 + 50)."""
    responses = [{}, {}, {}]
    client, transport = _make_client({"/v1/playlists/": responses})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    uris = [f"spotify:track:{i}" for i in range(250)]
    calls = await add_tracks_batch("fake-token", "pl-id", uris)
    assert calls == 3
    # Verify batch sizes via logged requests.
    assert len(transport._call_log) == 3
    body1 = json.loads(transport._call_log[0].content)
    assert len(body1["uris"]) == 100
    body3 = json.loads(transport._call_log[2].content)
    assert len(body3["uris"]) == 50


# ---------------------------------------------------------------------------
# create_playlist
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_playlist(monkeypatch):
    resp_body = {
        "id": "new-pl-123",
        "external_urls": {"spotify": "https://open.spotify.com/playlist/new-pl-123"},
    }
    client, _ = _make_client({"/v1/users/": [resp_body]})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    result = await create_playlist("fake-token", "user1", "Test Playlist")
    assert result["id"] == "new-pl-123"
    assert "spotify.com" in result["url"]


# ---------------------------------------------------------------------------
# get_playlist
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_playlist(monkeypatch):
    resp_body = {
        "id": "pl-1",
        "name": "My Mix",
        "tracks": {"total": 55},
        "owner": {"display_name": "User"},
    }
    client, _ = _make_client({"/v1/playlists/": [resp_body]})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    result = await get_playlist("fake-token", "pl-1")
    assert result["name"] == "My Mix"
    assert result["total_tracks"] == 55


# ---------------------------------------------------------------------------
# get_current_user_id
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_current_user_id(monkeypatch):
    resp_body = {"id": "spotify-user-42"}
    client, _ = _make_client({"/v1/me": [resp_body]})
    monkeypatch.setattr("app.spotify.httpx.AsyncClient", lambda: client)

    uid = await get_current_user_id("fake-token")
    assert uid == "spotify-user-42"
