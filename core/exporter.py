"""Export/Import logic — run state as JSON (NEVER includes tokens).

The export format is versioned.  v1 was Spotify-only and stored full
``spotify:track:...`` URIs under ``shuffled_order``; v2 is provider-aware and
stores provider-native ids under ``order``.  :func:`import_run` accepts both.

**v2 is a LOSSY legacy export against the v3 run model** (WP3-D2): it carries
only order + cursor + status.  The v3 run layer's config binding, per-track
states (``run_tracks``: play counts, favourites, exclusions, deferrals),
cycle number and plan/ledger history are NOT exported — an imported run is a
fresh order_json-only run bound to the legacy preset.  A v3 export format
that round-trips ``run_tracks`` comes later; until then ``EXPORT_VERSION``
stays 2 and this limitation is deliberate and documented rather than half
solved.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Dict, List, Optional

from core.models import EXPORT_VERSION, ExportPayload, RunMode, RunStatus

#: Keys that must never survive a round trip, whatever the caller sends.
_FORBIDDEN_KEYS = (
    "token_data",
    "token_blob",
    "access_token",
    "refresh_token",
    "music_user_token",
    "developer_token",
    "secret_key",
    "client_secret",
)


def export_run(
    *,
    provider: str,
    playlist_id: str,
    mode: str,
    order: List[str],
    cursor: int,
    status: str,
    playlist_name: str = "",
) -> str:
    """Serialize a run state to JSON.  OAuth tokens are **never** included."""
    payload = ExportPayload(
        version=EXPORT_VERSION,
        provider=provider,
        playlist_id=playlist_id,
        playlist_name=playlist_name,
        mode=RunMode(mode),
        order=order,
        cursor=cursor,
        status=RunStatus(status),
        exported_at=datetime.now(UTC).isoformat(),
    )
    return payload.model_dump_json(indent=2)


def _strip_spotify_uri(value: str) -> str:
    """``spotify:track:ABC`` → ``ABC`` (v1 exports stored full URIs)."""
    if value.startswith("spotify:track:"):
        return value.rsplit(":", 1)[-1]
    return value


def _upgrade_v1(data: Dict[str, Any]) -> Dict[str, Any]:
    """Translate a v1 (Spotify-only) export into the v2 shape."""
    legacy_order = data.pop("shuffled_order", [])
    data["order"] = [_strip_spotify_uri(u) for u in legacy_order]
    data.setdefault("provider", "spotify")
    data["version"] = EXPORT_VERSION
    return data


def import_run(raw_json: str) -> ExportPayload:
    """Parse JSON back into an :class:`ExportPayload`.

    Raises ``ValueError`` if the JSON is invalid or the payload is unusable.
    """
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("Export payload must be a JSON object")

    # Safety: strip anything that looks like a credential before parsing.
    for forbidden in _FORBIDDEN_KEYS:
        data.pop(forbidden, None)

    if "shuffled_order" in data or int(data.get("version", 1)) < 2:
        data = _upgrade_v1(data)

    try:
        payload = ExportPayload(**data)
    except Exception as exc:  # pydantic ValidationError and friends
        raise ValueError(f"Unsupported export payload: {exc}") from exc

    if not payload.order:
        raise ValueError("Export contains no tracks")
    if not 0 <= payload.cursor <= len(payload.order):
        raise ValueError("Export cursor is out of range")
    return payload


def resume_status(payload: ExportPayload) -> Optional[RunStatus]:
    """Status an imported run should get: finished decks stay finished."""
    if payload.cursor >= len(payload.order):
        return RunStatus.COMPLETED
    return RunStatus.PAUSED
