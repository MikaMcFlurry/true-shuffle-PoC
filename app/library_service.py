"""Playlist import, snapshots and sync diffs — the content-layer service (WP3-D1).

Carries UC-03 (versioned import), UC-04 (sync) and the RUN-09 basis ("show the
result BEFORE applying it").  Persistence lives in the v3 content layer that
M002 created: ``playlists`` → ``playlist_snapshots`` → ``snapshot_items``,
with ``snapshot_diffs`` as the RUN-09 anchor.

Design rules (Blueprint §2.1, ADR-003 F3)
-----------------------------------------
* **Nothing is discarded on import.**  Every playlist entry — duplicates,
  local files, unavailable titles, podcast episodes, id-less items — becomes
  a ``snapshot_items`` row with an honest ``availability`` derived from the
  same classification the shuffle uses (:meth:`core.models.Track.invalid_reason`).
  Whether a duplicate collapses or an unavailable title is excluded is a
  *rule* applied at run time, not a fact silently baked into the data.  A
  title that comes back into the market can therefore re-enter a run on the
  next sync instead of being gone forever.
* **Entry identity** is ``f"{provider_track_id or local_key}#{occurrence}"``
  — the only identity that stays stable across snapshots when positions
  move.  "The same song twice in the playlist" thereby becomes a data
  statement (entry ``…#0`` and ``…#1``), and its treatment a policy.
* **``content_hash``** is a sha256 over the ordered ``(entry_uid, position)``
  sequence, so "nothing changed since last time" is answerable without
  computing a diff.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app import db, jobs, migrations
from core.models import PlaylistRef, SkipReason, Track
from providers.base import ProviderContentUnavailable

# ---------------------------------------------------------------------------
# Availability classification
# ---------------------------------------------------------------------------

#: ``Track.invalid_reason()`` → ``snapshot_items.availability``.  DUPLICATE is
#: deliberately absent: the classifier never returns it (only the shuffle's
#: dedup assigns it), and at snapshot level a duplicate entry IS playable —
#: collapsing is the run's rule (F3), not the import's verdict.
_AVAILABILITY: Dict[SkipReason, str] = {
    SkipReason.LOCAL_FILE: "local",
    SkipReason.NOT_PLAYABLE: "unavailable",
    SkipReason.WRONG_KIND: "wrong_kind",
    SkipReason.MISSING_ID: "missing_id",
    SkipReason.NOT_MUSIC: "not_music",
}


def availability_of(track: Track) -> str:
    """Map the existing playability classification onto the snapshot enum."""
    reason = track.invalid_reason()
    if reason is None:
        return "playable"
    # Anything the mapping does not know (a future SkipReason, or a connector
    # that hands out DUPLICATE as an exclude_reason) is at least honest as
    # "unavailable" — it will not enter a run, but it stays in the snapshot.
    return _AVAILABILITY.get(reason, "unavailable")


def entry_identity(track: Track) -> str:
    """The stable identity half of the entry_uid: provider id or local key."""
    if track.id:
        return track.id
    return migrations._local_key(
        track.name, track.artist, track.album, track.duration_ms
    )


def content_hash(entries: Sequence[Tuple[str, int]]) -> str:
    """sha256 over the ordered ``(entry_uid, position)`` sequence."""
    canonical = json.dumps(list(entries), separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _source_etag(playlist: PlaylistRef) -> str:
    """The provider's cheap change marker (Spotify ``snapshot_id``), if the
    connector surfaces one on its PlaylistRef.  None does today — the value
    then stays '' and every consumer must treat it as "unknown", never as
    "unchanged"."""
    return str(getattr(playlist, "source_etag", "") or "")


# ---------------------------------------------------------------------------
# Playlists (the per-user registry row)
# ---------------------------------------------------------------------------

async def upsert_playlist(user_id: int, playlist: PlaylistRef) -> int:
    """Get-or-update the user's ``playlists`` row for a provider playlist."""
    conn = db.get_db()
    await conn.execute(
        """
        INSERT INTO playlists (user_id, provider, provider_playlist_id, name,
                               owner, editable, readable, unreadable_reason,
                               image_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider, provider_playlist_id) DO UPDATE SET
            name              = excluded.name,
            owner             = excluded.owner,
            editable          = excluded.editable,
            readable          = excluded.readable,
            unreadable_reason = excluded.unreadable_reason,
            image_url         = excluded.image_url
        """,
        (
            user_id, playlist.provider, playlist.id, playlist.name,
            playlist.owner, 1 if playlist.editable else 0,
            1 if playlist.readable else 0, playlist.unreadable_reason,
            playlist.image_url,
        ),
    )
    await conn.commit()
    cur = await conn.execute(
        "SELECT id FROM playlists WHERE user_id = ? AND provider = ? "
        "AND provider_playlist_id = ?",
        (user_id, playlist.provider, playlist.id),
    )
    row = await cur.fetchone()
    assert row is not None
    return int(row[0])


async def get_playlist_row(
    user_id: int, provider: str, provider_playlist_id: str
) -> Optional[Dict[str, Any]]:
    """The user's playlist registry row — ownership is part of the query."""
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT * FROM playlists WHERE user_id = ? AND provider = ? "
        "AND provider_playlist_id = ?",
        (user_id, provider, provider_playlist_id),
    )
    row = await cur.fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Import (UC-03)
# ---------------------------------------------------------------------------

async def import_playlist(
    session, playlist_ref: PlaylistRef, *, job_id: str = ""
) -> Dict[str, Any]:
    """Import one playlist as a new, versioned snapshot.

    Streams ALL entries via ``iter_playlist_tracks`` (reporting progress to
    *job_id* if given), persists every one of them — nothing is dropped —
    and finishes the snapshot ``importing → ready``.  A provider failure
    mid-stream finishes it ``importing → failed`` and re-raises: there is
    never a half-imported snapshot claiming to be ready.

    Returns a display-ready summary of the new snapshot.
    """
    if not playlist_ref.readable:
        raise ProviderContentUnavailable(
            playlist_ref.unreadable_reason
            or "Dieser Dienst gibt den Inhalt dieser Playlist nicht heraus."
        )

    conn = db.get_db()
    playlist_pk = await upsert_playlist(session.user_id, playlist_ref)

    # New version = max + 1 over ALL snapshots (failed ones included) so a
    # retry after a failure never reuses a version number.
    cur = await conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM playlist_snapshots "
        "WHERE playlist_id = ?",
        (playlist_pk,),
    )
    version = int((await cur.fetchone())[0])
    cur = await conn.execute(
        "INSERT INTO playlist_snapshots (playlist_id, version, source_etag, "
        "status, job_id) VALUES (?, ?, ?, 'importing', ?)",
        (playlist_pk, version, _source_etag(playlist_ref), job_id),
    )
    snapshot_id = int(cur.lastrowid or 0)
    # Commit the shell on its own: whatever happens to the stream below, the
    # snapshot row exists and can carry an honest terminal status.
    await conn.commit()

    total_hint = max(playlist_ref.track_count, 0)
    position = 0
    playable = 0
    occurrences: Dict[str, int] = {}
    hashed: List[Tuple[str, int]] = []

    try:
        async for page in session.provider.iter_playlist_tracks(
            session.token, playlist_ref.id
        ):
            for track in page:
                identity = entry_identity(track)
                occurrence = occurrences.get(identity, 0)
                occurrences[identity] = occurrence + 1
                entry_uid = f"{identity}#{occurrence}"
                availability = availability_of(track)
                if availability == "playable":
                    playable += 1
                track_pk = await migrations.ensure_track(
                    conn, playlist_ref.provider, track.id,
                    name=track.name, artist=track.artist, album=track.album,
                    duration_ms=track.duration_ms, is_local=track.is_local,
                )
                await conn.execute(
                    "INSERT INTO snapshot_items (snapshot_id, position, "
                    "track_id, entry_uid, availability) VALUES (?, ?, ?, ?, ?)",
                    (snapshot_id, position, track_pk, entry_uid, availability),
                )
                hashed.append((entry_uid, position))
                position += 1
            await conn.commit()
            if job_id:
                await jobs.report(
                    job_id, position, max(total_hint, position),
                    "importing playlist",
                )

        digest = content_hash(hashed)
        await conn.execute(
            "UPDATE playlist_snapshots SET status = 'ready', content_hash = ?, "
            "item_count = ?, playable_count = ?, excluded_count = ?, "
            "imported_at = datetime('now') WHERE id = ?",
            (digest, position, playable, position - playable, snapshot_id),
        )
        await conn.execute(
            "UPDATE playlists SET last_imported_at = datetime('now') "
            "WHERE id = ?",
            (playlist_pk,),
        )
        await conn.commit()
    except BaseException:
        # Discard the half-written page, then say honestly what happened.
        # Items of earlier (already committed) pages stay attached to the
        # failed snapshot; every reader filters on status = 'ready'.
        await conn.rollback()
        await conn.execute(
            "UPDATE playlist_snapshots SET status = 'failed' WHERE id = ?",
            (snapshot_id,),
        )
        await conn.commit()
        raise

    # "Unchanged since the previous import" — cheap, via content_hash alone.
    cur = await conn.execute(
        "SELECT content_hash FROM playlist_snapshots WHERE playlist_id = ? "
        "AND status = 'ready' AND id < ? ORDER BY id DESC LIMIT 1",
        (playlist_pk, snapshot_id),
    )
    row = await cur.fetchone()
    previous_hash = str(row[0]) if row else None

    cur = await conn.execute(
        "SELECT imported_at FROM playlist_snapshots WHERE id = ?", (snapshot_id,)
    )
    imported_at = str((await cur.fetchone())[0])

    return {
        "playlist_id": playlist_pk,
        "provider": playlist_ref.provider,
        "provider_playlist_id": playlist_ref.id,
        "playlist_name": playlist_ref.name,
        "snapshot_id": snapshot_id,
        "version": version,
        "status": "ready",
        "item_count": position,
        "playable_count": playable,
        "excluded_count": position - playable,
        "content_hash": content_hash(hashed),
        "unchanged": previous_hash == content_hash(hashed),
        "imported_at": imported_at,
    }


# ---------------------------------------------------------------------------
# Status accessors (GET …/snapshot and the /api/playlists annotation)
# ---------------------------------------------------------------------------

async def snapshot_status(
    user_id: int, provider: str, provider_playlist_id: str
) -> Optional[Dict[str, Any]]:
    """The newest snapshot (any status) of the caller's playlist, or None."""
    playlist = await get_playlist_row(user_id, provider, provider_playlist_id)
    if playlist is None:
        return None
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT id, version, status, source_etag, content_hash, item_count, "
        "playable_count, excluded_count, imported_at FROM playlist_snapshots "
        "WHERE playlist_id = ? ORDER BY id DESC LIMIT 1",
        (playlist["id"],),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    snap = dict(row)
    return {
        "provider": provider,
        "playlist_id": provider_playlist_id,
        "name": playlist["name"],
        "snapshot_id": snap["id"],
        "version": snap["version"],
        "status": snap["status"],
        "item_count": snap["item_count"],
        "playable_count": snap["playable_count"],
        "excluded_count": snap["excluded_count"],
        "imported_at": snap["imported_at"],
        "last_imported_at": playlist["last_imported_at"],
        "content_hash": snap["content_hash"],
        "source_etag": snap["source_etag"],
    }


async def import_overview(user_id: int, provider: str) -> Dict[str, Dict[str, Any]]:
    """Latest READY snapshot per playlist, keyed by provider_playlist_id.

    One query for the whole library listing — this is what keeps the
    ``/api/playlists`` annotation cheap.
    """
    conn = db.get_db()
    cur = await conn.execute(
        """
        SELECT p.provider_playlist_id, s.version, s.item_count,
               s.playable_count, s.imported_at, s.source_etag
        FROM playlists p
        JOIN playlist_snapshots s ON s.playlist_id = p.id
        WHERE p.user_id = ? AND p.provider = ? AND s.status = 'ready'
          AND s.id = (SELECT MAX(s2.id) FROM playlist_snapshots s2
                      WHERE s2.playlist_id = p.id AND s2.status = 'ready')
        """,
        (user_id, provider),
    )
    return {str(r["provider_playlist_id"]): dict(r) for r in await cur.fetchall()}


def import_status_field(
    playlist: PlaylistRef, info: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """The ``import_status`` object one listed playlist carries.

    ``sync_available`` appears ONLY when a stale import is cheaply provable:
    both the stored snapshot and the freshly listed playlist carry a
    source_etag and they differ.  Where the connector hands out no etag the
    field is honestly absent — "we cannot know without importing" must never
    be dressed up as "no sync needed".
    """
    if not info:
        return {"imported": False}
    field: Dict[str, Any] = {
        "imported": True,
        "version": info["version"],
        "imported_at": info["imported_at"],
        "item_count": info["item_count"],
        "playable_count": info["playable_count"],
    }
    current = _source_etag(playlist)
    stored = str(info.get("source_etag") or "")
    if current and stored:
        field["sync_available"] = current != stored
    return field


# ---------------------------------------------------------------------------
# Sync diff (UC-04 / RUN-09)
# ---------------------------------------------------------------------------

async def _snapshot_entries(snapshot_id: int) -> List[Dict[str, Any]]:
    conn = db.get_db()
    cur = await conn.execute(
        """
        SELECT si.entry_uid, si.position, si.availability,
               t.provider_track_id, t.name, t.artist
        FROM snapshot_items si JOIN tracks t ON t.id = si.track_id
        WHERE si.snapshot_id = ? ORDER BY si.position
        """,
        (snapshot_id,),
    )
    return [dict(r) for r in await cur.fetchall()]


def _entry_view(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "entry_uid": entry["entry_uid"],
        "position": entry["position"],
        "track_id": entry["provider_track_id"],
        "name": entry["name"],
        "artist": entry["artist"],
        "availability": entry["availability"],
    }


async def compute_sync_diff(playlist_id: int) -> Optional[Dict[str, Any]]:
    """Diff the newest READY snapshot against the previous one (RUN-09).

    Returns a display-ready dict — added / removed / moved plus availability
    changes (a title coming BACK is flagged ``readded``) — and persists the
    ``snapshot_diffs`` row idempotently.  The diff is *shown before it is
    applied*: ``applied_at`` stays NULL here and is stamped by
    :func:`apply_sync_to_run` (WP3-D3).

    ``None`` when the playlist has fewer than two ready snapshots — a first
    import has nothing to be compared against.
    """
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT id, version, content_hash FROM playlist_snapshots "
        "WHERE playlist_id = ? AND status = 'ready' ORDER BY id DESC LIMIT 2",
        (playlist_id,),
    )
    snapshots = [dict(r) for r in await cur.fetchall()]
    if len(snapshots) < 2:
        return None
    new, old = snapshots[0], snapshots[1]

    old_entries = {e["entry_uid"]: e for e in await _snapshot_entries(old["id"])}
    new_entries = {e["entry_uid"]: e for e in await _snapshot_entries(new["id"])}

    added = [
        _entry_view(e) for uid, e in new_entries.items() if uid not in old_entries
    ]
    removed = [
        _entry_view(e) for uid, e in old_entries.items() if uid not in new_entries
    ]
    added.sort(key=lambda e: e["position"])
    removed.sort(key=lambda e: e["position"])

    moved: List[Dict[str, Any]] = []
    availability_changed: List[Dict[str, Any]] = []
    for uid, entry in new_entries.items():
        before = old_entries.get(uid)
        if before is None:
            continue
        if before["position"] != entry["position"]:
            moved.append({
                "entry_uid": uid,
                "name": entry["name"],
                "artist": entry["artist"],
                "from_position": before["position"],
                "to_position": entry["position"],
            })
        if before["availability"] != entry["availability"]:
            availability_changed.append({
                "entry_uid": uid,
                "name": entry["name"],
                "artist": entry["artist"],
                "from": before["availability"],
                "to": entry["availability"],
                # UC-04 / ERR-06: the case the whole layer exists for — a
                # title that is available AGAIN and may re-enter the run.
                "readded": entry["availability"] == "playable",
            })
    moved.sort(key=lambda e: e["to_position"])
    availability_changed.sort(key=lambda e: e["entry_uid"])

    # Persist idempotently: the diff between two frozen snapshots is
    # deterministic, so OR IGNORE keeps the first row (and its applied_at —
    # WP3-D3 stamps that exactly once) without ever rewriting it.
    await conn.execute(
        "INSERT OR IGNORE INTO snapshot_diffs (from_snapshot_id, "
        "to_snapshot_id, added_json, removed_json, moved_count) "
        "VALUES (?, ?, ?, ?, ?)",
        (old["id"], new["id"], json.dumps(added), json.dumps(removed),
         len(moved)),
    )
    await conn.commit()
    cur = await conn.execute(
        "SELECT id, applied_at, created_at FROM snapshot_diffs "
        "WHERE from_snapshot_id = ? AND to_snapshot_id = ?",
        (old["id"], new["id"]),
    )
    row = await cur.fetchone()
    assert row is not None

    return {
        "diff_id": int(row["id"]),
        "playlist_id": playlist_id,
        "from_snapshot_id": old["id"],
        "from_version": old["version"],
        "to_snapshot_id": new["id"],
        "to_version": new["version"],
        "unchanged": old["content_hash"] == new["content_hash"],
        "added": added,
        "removed": removed,
        "moved": moved,
        "moved_count": len(moved),
        "availability_changed": availability_changed,
        "applied_at": row["applied_at"],
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# Applying a diff to a run — WP3-D3's contract, fixed now
# ---------------------------------------------------------------------------

async def apply_sync_to_run(
    run_id: int,
    *,
    diff_id: int,
    user_id: int,
    new_tracks_policy: Optional[str] = None,
) -> Dict[str, Any]:
    """Apply a computed snapshot diff to a live run.  **WP3-D3 implements this.**

    The contract is fixed here so D3 extends behaviour, not the surface:

    * ``run_id`` / ``user_id`` — the run whose deck is updated; ownership is
      part of the query (a foreign run behaves like a missing one, exactly as
      :func:`app.deps.require_run` does).
    * ``diff_id`` — a ``snapshot_diffs`` row as returned by
      :func:`compute_sync_diff`; its ``to_snapshot_id`` must be a READY
      snapshot of the run's playlist, otherwise the call is a 409-shaped
      error, never a partial apply.
    * ``new_tracks_policy`` — ``'include_now' | 'after_cycle' | 'ignore'``;
      ``None`` reads the run's config (``run_configs.new_tracks_policy``,
      legacy preset default: ``'ignore'``).

    Behaviour D3 must deliver:

    * *added* entries become ``run_tracks`` rows (``admitted`` per policy,
      ``added_in_cycle`` = current cycle, ``source_snapshot_id`` = the diff's
      target snapshot);
    * *removed* entries set ``run_tracks.removed_from_snapshot = 1`` — the
      play history stays (UC-04), nothing is deleted;
    * *re-available* entries (``availability_changed`` with ``readded``)
      re-open their excluded rows when the run's ``unplayable_policy`` is
      ``'retry_next_cycle'``;
    * ``runs.snapshot_id`` moves to the diff's ``to_snapshot_id`` and
      ``snapshot_diffs.applied_at`` is stamped — exactly once; a second apply
      of the same diff is a no-op answered with the first result (idempotent,
      like every v3 mutation);
    * returns ``{"added": n, "removed": n, "reopened": n, "policy": str}``.
    """
    raise NotImplementedError(
        "apply_sync_to_run kommt mit WP3-D3 — der Diff wird bis dahin nur "
        "angezeigt (RUN-09), nie angewendet."
    )


__all__ = [
    "apply_sync_to_run",
    "availability_of",
    "compute_sync_diff",
    "content_hash",
    "entry_identity",
    "get_playlist_row",
    "import_overview",
    "import_playlist",
    "import_status_field",
    "snapshot_status",
    "upsert_playlist",
]
