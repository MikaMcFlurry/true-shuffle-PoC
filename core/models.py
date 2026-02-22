"""Pydantic models shared across the application."""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class Track(BaseModel):
    """Minimal representation of a Spotify track."""

    uri: str  # e.g. "spotify:track:6rqhFgbbKwnb9MLmUQDhG6"
    name: str = ""
    artist: str = ""
    is_playable: bool = True
    is_local: bool = False
    track_type: str = "track"  # "track" | "episode"

    @property
    def is_valid(self) -> bool:
        """True if the track can be shuffled and played."""
        return (
            self.is_playable
            and not self.is_local
            and self.track_type == "track"
            and self.uri.startswith("spotify:track:")
        )


class RunState(BaseModel):
    """Snapshot of a shuffle run (for persistence and export)."""

    run_id: int = 0
    user_id: int = 0
    playlist_id: str = ""
    mode: str = "utility"  # "utility" | "controller"
    shuffled_order: List[str] = Field(default_factory=list)  # list of URIs
    cursor: int = 0
    status: str = "active"  # "active" | "completed" | "cancelled"


class ExportPayload(BaseModel):
    """JSON export of a run — never contains tokens."""

    playlist_id: str
    mode: str
    shuffled_order: List[str]
    cursor: int
    status: str
    exported_at: str = ""

    model_config = {
        "json_schema_extra": {
            "description": "Run state export — OAuth tokens are NEVER included."
        }
    }
