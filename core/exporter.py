"""Export/Import logic — run state as JSON (NEVER includes tokens)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import List

from core.models import ExportPayload


def export_run(
    playlist_id: str,
    mode: str,
    shuffled_order: List[str],
    cursor: int,
    status: str,
) -> str:
    """Serialize a run state to JSON.

    Returns a JSON string.  OAuth tokens are **never** included.
    """
    payload = ExportPayload(
        playlist_id=playlist_id,
        mode=mode,
        shuffled_order=shuffled_order,
        cursor=cursor,
        status=status,
        exported_at=datetime.now(timezone.utc).isoformat(),
    )
    return payload.model_dump_json(indent=2)


def import_run(raw_json: str) -> ExportPayload:
    """Parse JSON back into an ExportPayload.

    Raises ``ValueError`` if the JSON is invalid or contains unexpected fields.
    """
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc

    # Safety: strip any field that could be a token or sensitive data
    for forbidden in ("token_data", "access_token", "refresh_token", "secret_key"):
        data.pop(forbidden, None)

    return ExportPayload(**data)
