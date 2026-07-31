"""Content layer WP3-D1: playlist import / snapshot / sync (UC-03, UC-04, RUN-09).

Covers the work package's acceptance points against a real v3 database
(the shared ``database`` fixture runs the full migration chain, exactly like
``tests/test_migrations.py``):

* duplicates are persisted as entries (entry_uid ``…#0`` / ``…#1``), never
  collapsed away at import time (ADR-003 F3);
* local / unavailable / wrong-kind / id-less entries are persisted with an
  honest ``availability`` — nothing is discarded;
* a second import gets version 2 and a correct diff: added, removed, moved,
  and a title that is available AGAIN (``readded``);
* ``content_hash`` is stable for identical content and order-sensitive;
* a provider that breaks mid-stream leaves a ``failed`` snapshot — never a
  half-imported ``ready`` one;
* ownership and the API contracts of the four new routes.
"""

from __future__ import annotations

import base64
import json
import time
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app import db as db_module
from app import library_service
from app.accounts import Session
from app.main import app
from core.models import PlaylistRef, Track, TrackKind
from providers.base import ProviderError, TokenBundle
from tests.conftest import FakeProvider

# ---------------------------------------------------------------------------
# Local fixtures (deliberately NOT in conftest.py — WP3-D1 keeps to itself)
# ---------------------------------------------------------------------------


class ScriptedProvider(FakeProvider):
    """A connector whose pages — and mid-stream failures — the test scripts."""

    def __init__(self) -> None:
        super().__init__("fake")
        self.pages: list[list[Track]] = []
        #: Raise after yielding this many pages (None = never).
        self.fail_after: int | None = None

    async def iter_playlist_tracks(self, token, playlist_id):
        for index, page in enumerate(self.pages):
            if self.fail_after is not None and index >= self.fail_after:
                raise ProviderError("Der Dienst hat die Verbindung abgebrochen.")
            yield page


def track(tid: str, **kwargs) -> Track:
    kwargs.setdefault("provider", "fake")
    if "name" not in kwargs:
        kwargs["name"] = tid or "Ohne ID"
    return Track(id=tid, **kwargs)


@pytest_asyncio.fixture
async def content(database):
    """A fresh v3 database, one user, and a scripted provider session."""
    user_id = await db_module.get_or_create_user("local-lib")
    provider = ScriptedProvider()
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = PlaylistRef(provider="fake", id="pl1", name="Alles")
    return SimpleNamespace(
        db=database, user_id=user_id, provider=provider,
        session=session, playlist=playlist,
    )


async def _rows(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    return [tuple(r) for r in await cur.fetchall()]


async def _one(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


# ---------------------------------------------------------------------------
# Import: nothing is discarded, duplicates become entries
# ---------------------------------------------------------------------------


async def test_import_persists_every_entry_with_duplicates_and_availability(content):
    content.provider.pages = [
        [
            track("t1"),
            track("t2", is_local=True),
            track("t1"),                                  # duplicate → …#1
        ],
        [
            track("t3", is_playable=False),
            track("t4", kind=TrackKind.EPISODE),
            track("", name="Nur lokal", artist="X", duration_ms=1000),
        ],
    ]

    result = await library_service.import_playlist(content.session, content.playlist)

    assert result["version"] == 1
    assert result["status"] == "ready"
    assert result["item_count"] == 6          # every entry, nothing dropped
    assert result["playable_count"] == 2      # t1 twice — both entries playable
    assert result["excluded_count"] == 4
    assert result["content_hash"]
    assert result["unchanged"] is False       # a first import has no “previous”

    rows = await _rows(
        content.db,
        """
        SELECT si.position, si.entry_uid, si.availability, t.provider_track_id
        FROM snapshot_items si JOIN tracks t ON t.id = si.track_id
        WHERE si.snapshot_id = ? ORDER BY si.position
        """,
        (result["snapshot_id"],),
    )
    assert len(rows) == 6
    assert [r[0] for r in rows] == [0, 1, 2, 3, 4, 5]

    # F3: “the same song twice” is a data statement — two entries, one track.
    assert rows[0][1] == "t1#0" and rows[0][2] == "playable"
    assert rows[2][1] == "t1#1" and rows[2][2] == "playable"
    assert rows[1][1] == "t2#0" and rows[1][2] == "local"
    assert rows[3][1] == "t3#0" and rows[3][2] == "unavailable"
    assert rows[4][1] == "t4#0" and rows[4][2] == "wrong_kind"

    # The id-less entry lives via its local_key identity, not an empty uid.
    local_uid, local_availability = rows[5][1], rows[5][2]
    assert local_availability == "missing_id"
    assert local_uid.endswith("#0") and len(local_uid) > len("#0")
    assert rows[5][3] == ""                                   # no provider id

    # Track identity is deduplicated even though entries are not.
    assert await _one(content.db, "SELECT count(*) FROM tracks") == 5
    assert await _one(
        content.db,
        "SELECT count(*) FROM tracks WHERE provider_track_id = '' AND local_key != ''",
    ) == 1

    # The registry row was stamped.
    playlist_row = await library_service.get_playlist_row(
        content.user_id, "fake", "pl1"
    )
    assert playlist_row is not None and playlist_row["last_imported_at"]


# ---------------------------------------------------------------------------
# content_hash: stable for identical content, sensitive to order
# ---------------------------------------------------------------------------


async def test_content_hash_is_stable_and_order_sensitive(content):
    content.provider.pages = [[track("a"), track("b"), track("c")]]
    first = await library_service.import_playlist(content.session, content.playlist)
    second = await library_service.import_playlist(content.session, content.playlist)

    assert second["version"] == 2
    assert second["content_hash"] == first["content_hash"]
    assert second["unchanged"] is True

    diff = await library_service.compute_sync_diff(first["playlist_id"])
    assert diff is not None
    assert diff["unchanged"] is True
    assert diff["added"] == [] and diff["removed"] == []
    assert diff["moved_count"] == 0 and diff["availability_changed"] == []

    content.provider.pages = [[track("a"), track("c"), track("b")]]
    third = await library_service.import_playlist(content.session, content.playlist)
    assert third["content_hash"] != first["content_hash"]
    assert third["unchanged"] is False


# ---------------------------------------------------------------------------
# Version 2 diff: added / removed / moved / available again
# ---------------------------------------------------------------------------


async def test_second_import_diffs_add_remove_move_and_readded(content):
    content.provider.pages = [[
        track("a"),
        track("b", is_playable=False),   # unavailable in version 1 …
        track("c"),
        track("d"),
    ]]
    first = await library_service.import_playlist(content.session, content.playlist)

    content.provider.pages = [[
        track("b"),                      # … available AGAIN in version 2
        track("d"),
        track("c"),
        track("e"),
    ]]
    second = await library_service.import_playlist(content.session, content.playlist)
    assert second["version"] == 2

    diff = await library_service.compute_sync_diff(first["playlist_id"])
    assert diff is not None
    assert diff["from_version"] == 1 and diff["to_version"] == 2
    assert diff["unchanged"] is False

    assert [e["entry_uid"] for e in diff["added"]] == ["e#0"]
    assert diff["added"][0]["position"] == 3
    assert [e["entry_uid"] for e in diff["removed"]] == ["a#0"]

    moved = {e["entry_uid"]: (e["from_position"], e["to_position"])
             for e in diff["moved"]}
    assert moved == {"b#0": (1, 0), "d#0": (3, 1)}     # c stayed at 2
    assert diff["moved_count"] == 2

    assert diff["availability_changed"] == [{
        "entry_uid": "b#0", "name": "b", "artist": "",
        "from": "unavailable", "to": "playable", "readded": True,
    }]

    # RUN-09: computed to be SHOWN, not applied — and persisted idempotently.
    assert diff["applied_at"] is None
    row = await _rows(
        content.db,
        "SELECT added_json, removed_json, moved_count, applied_at "
        "FROM snapshot_diffs WHERE id = ?",
        (diff["diff_id"],),
    )
    added_json, removed_json, moved_count, applied_at = row[0]
    assert [e["entry_uid"] for e in json.loads(added_json)] == ["e#0"]
    assert [e["entry_uid"] for e in json.loads(removed_json)] == ["a#0"]
    assert moved_count == 2 and applied_at is None

    again = await library_service.compute_sync_diff(first["playlist_id"])
    assert again is not None and again["diff_id"] == diff["diff_id"]
    assert await _one(content.db, "SELECT count(*) FROM snapshot_diffs") == 1


# ---------------------------------------------------------------------------
# Failure path: a broken stream never yields a half-imported “ready”
# ---------------------------------------------------------------------------


async def test_provider_failure_mid_stream_marks_the_snapshot_failed(content):
    content.provider.pages = [[track("a"), track("b")], [track("c")]]
    content.provider.fail_after = 1                    # dies before page 2

    with pytest.raises(ProviderError):
        await library_service.import_playlist(content.session, content.playlist)

    statuses = await _rows(
        content.db, "SELECT version, status FROM playlist_snapshots ORDER BY id"
    )
    assert statuses == [(1, "failed")]
    assert await _one(
        content.db,
        "SELECT count(*) FROM playlist_snapshots WHERE status = 'ready'",
    ) == 0
    # A failed import is not “imported”.
    playlist_row = await library_service.get_playlist_row(
        content.user_id, "fake", "pl1"
    )
    assert playlist_row["last_imported_at"] is None
    assert await library_service.import_overview(content.user_id, "fake") == {}
    # …but the status endpoint payload says honestly what happened.
    status = await library_service.snapshot_status(content.user_id, "fake", "pl1")
    assert status is not None and status["status"] == "failed"

    # The retry gets a fresh version number and a clean ready snapshot.
    content.provider.fail_after = None
    result = await library_service.import_playlist(content.session, content.playlist)
    assert result["version"] == 2 and result["status"] == "ready"
    assert result["item_count"] == 3
    # Still only ONE ready snapshot → no diff basis yet.
    assert await library_service.compute_sync_diff(result["playlist_id"]) is None


# ---------------------------------------------------------------------------
# WP3-D3 contract stub
# ---------------------------------------------------------------------------


async def test_apply_sync_to_run_is_reserved_for_wp3_d3(content):
    with pytest.raises(NotImplementedError):
        await library_service.apply_sync_to_run(
            1, diff_id=1, user_id=content.user_id, new_tracks_policy="ignore"
        )


# ---------------------------------------------------------------------------
# API contracts (TestClient, fake connector — same pattern as test_api.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def connect(client, provider_id: str = "fake") -> None:
    """Walk the OAuth flow far enough to have a connected account."""
    client.get(f"/auth/{provider_id}/login", follow_redirects=False)
    state = _session_state(client)
    client.get(
        f"/auth/{provider_id}/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )


def _session_state(client) -> str:
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    cookie = client.cookies.get("session")
    signer = TimestampSigner(get_settings().secret_key)
    data = signer.unsign(cookie, max_age=3600)
    return json.loads(base64.urlsafe_b64decode(data))["oauth_state"]


def wait_job(client, job_id: str) -> dict:
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            return snap["result"]
        if snap["status"] == "error":
            pytest.fail(f"job failed: {snap['message']}")
        time.sleep(0.05)
    pytest.fail("job did not finish in time")


def test_import_api_roundtrip_and_listing_status(client, fake_provider):
    connect(client)

    # Before any import the listing says so — and never fakes a sync verdict.
    listed = client.get("/api/playlists", params={"provider": "fake"}).json()
    pl1 = next(p for p in listed["playlists"] if p["id"] == "pl1")
    assert pl1["import_status"] == {"imported": False}

    response = client.post("/api/playlists/fake/pl1/import")
    assert response.status_code == 202
    result = wait_job(client, response.json()["job_id"])
    assert result["version"] == 1
    assert result["item_count"] == 12 and result["playable_count"] == 12

    snap = client.get("/api/playlists/fake/pl1/snapshot")
    assert snap.status_code == 200
    payload = snap.json()
    assert payload["version"] == 1 and payload["status"] == "ready"
    assert payload["item_count"] == 12
    assert payload["imported_at"] and payload["last_imported_at"]

    listed = client.get("/api/playlists", params={"provider": "fake"}).json()
    pl1 = next(p for p in listed["playlists"] if p["id"] == "pl1")
    assert pl1["import_status"]["imported"] is True
    assert pl1["import_status"]["version"] == 1
    assert pl1["import_status"]["item_count"] == 12
    # The fake connector hands out no source_etag → the field must be ABSENT,
    # not guessed (“we cannot know” is not “no sync needed”).
    assert "sync_available" not in pl1["import_status"]

    foreign = next(p for p in listed["playlists"] if p["id"] == "pl-foreign")
    assert foreign["import_status"] == {"imported": False}


def test_snapshot_and_diff_of_an_unimported_playlist_are_404(client, fake_provider):
    connect(client)
    assert client.get("/api/playlists/fake/pl1/snapshot").status_code == 404
    assert client.get("/api/playlists/fake/pl1/sync/latest").status_code == 404


def test_unreadable_playlist_import_is_refused_up_front(client, fake_provider):
    connect(client)
    response = client.post("/api/playlists/fake/pl-foreign/import")
    assert response.status_code == 422
    assert "Playlist" in response.json()["detail"]


def test_sync_api_imports_again_and_returns_the_diff(client, fake_provider):
    connect(client)
    wait_job(client, client.post("/api/playlists/fake/pl1/import").json()["job_id"])

    # The playlist changes at the service: t0 leaves, t99 arrives at the end.
    fake_provider.tracks = [
        *fake_provider.tracks[1:],
        Track(provider="fake", id="t99", name="Neu", artist="Artist"),
    ]

    response = client.post("/api/playlists/fake/pl1/sync")
    assert response.status_code == 202
    result = wait_job(client, response.json()["job_id"])

    assert result["import"]["version"] == 2
    diff = result["diff"]
    assert diff is not None
    assert [e["entry_uid"] for e in diff["added"]] == ["t99#0"]
    assert [e["entry_uid"] for e in diff["removed"]] == ["t0#0"]
    assert diff["moved_count"] == 11          # t1…t11 all shifted up one slot
    assert diff["applied_at"] is None         # RUN-09: shown, not applied

    latest = client.get("/api/playlists/fake/pl1/sync/latest")
    assert latest.status_code == 200
    assert latest.json()["diff_id"] == diff["diff_id"]
    assert latest.json()["to_version"] == 2


def test_playlist_content_endpoints_enforce_ownership(client, fake_provider):
    connect(client)
    wait_job(client, client.post("/api/playlists/fake/pl1/import").json()["job_id"])
    assert client.get("/api/playlists/fake/pl1/snapshot").status_code == 200

    with TestClient(app) as stranger:
        stranger.get("/api/providers")        # separate session, own user
        # A foreign playlist import behaves like a missing one — 404, never
        # a 403 that would confirm the resource exists.
        assert stranger.get("/api/playlists/fake/pl1/snapshot").status_code == 404
        assert stranger.get("/api/playlists/fake/pl1/sync/latest").status_code == 404
        # Starting an import needs a connected account of one's own.
        assert stranger.post("/api/playlists/fake/pl1/import").status_code == 409

    # No session at all → 401 before any lookup happens.
    with TestClient(app) as anonymous:
        assert anonymous.get("/api/playlists/fake/pl1/snapshot").status_code == 401
