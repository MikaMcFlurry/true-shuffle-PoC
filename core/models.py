"""Provider-agnostic domain models.

Nothing in this module knows about Spotify, Apple Music or YouTube.  A
:class:`Track` is identified by ``(provider, id)``; every connector maps its
own payloads onto these types.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

class RunMode(str, Enum):
    """How a run delivers audio to the listener."""

    #: Write a shuffled copy playlist into the provider; the user presses play
    #: there.  Works on every provider that can create playlists.
    UTILITY = "utility"

    #: true-shuffle drives playback itself and advances the cursor when a track
    #: ends or the user skips natively.  Requires a playback-capable provider.
    CONTROLLER = "controller"


class RunStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class SkipReason(str, Enum):
    """Why a playlist entry never entered the run.

    These are *entries removed before shuffling* — they are NOT tracks the user
    skipped.  See :class:`AdvanceReason` for that.
    """

    LOCAL_FILE = "local_file"
    NOT_PLAYABLE = "not_playable"
    WRONG_KIND = "wrong_kind"
    DUPLICATE = "duplicate"
    MISSING_ID = "missing_id"
    #: The entry plays fine but is not music — a talk, a trailer, a lecture.
    #: Only a connector can judge this, so it is set by the connector.
    NOT_MUSIC = "not_music"


class AdvanceReason(str, Enum):
    """Why the run cursor moved forward.

    The product rule (handoff §2.2): a *user* skip consumes the track for this
    run, an *unplayable entry* does not — it never made it into the order.
    """

    TRACK_ENDED = "track_ended"
    USER_SKIP = "user_skip"
    NATIVE_SKIP = "native_skip"   # skipped inside the provider's own app
    MANUAL = "manual"             # "next" pressed in the true-shuffle UI
    PLAYBACK_FAILED = "playback_failed"
    RESYNC = "resync"             # provider drifted; we re-asserted our order


class TrackKind(str, Enum):
    TRACK = "track"
    EPISODE = "episode"
    VIDEO = "video"
    UNKNOWN = "unknown"


#: Sentinel for :attr:`PlaylistRef.track_count` when the service lists a
#: playlist without saying how many entries it has.  Negative rather than zero,
#: because "I do not know" and "it is empty" lead to different sentences on
#: screen and different decisions in the run engine.
UNKNOWN_TRACK_COUNT = -1


# ---------------------------------------------------------------------------
# Content
# ---------------------------------------------------------------------------

class Track(BaseModel):
    """One playable item, normalised across providers."""

    provider: str
    id: str                       # provider-native identifier
    name: str = ""
    artist: str = ""
    album: str = ""
    duration_ms: int = 0
    is_playable: bool = True
    is_local: bool = False
    kind: TrackKind = TrackKind.TRACK
    artwork_url: str = ""
    #: Set by a connector that knows something the generic rules cannot see.
    exclude_reason: Optional[SkipReason] = None

    @property
    def key(self) -> str:
        """Stable cross-provider identity used for dedup and run order."""
        return f"{self.provider}:{self.id}"

    def invalid_reason(self) -> Optional[SkipReason]:
        """Return why this track cannot enter a run, or ``None`` if it can."""
        if self.exclude_reason is not None:
            return self.exclude_reason
        if not self.id:
            return SkipReason.MISSING_ID
        if self.is_local:
            return SkipReason.LOCAL_FILE
        if self.kind not in (TrackKind.TRACK, TrackKind.VIDEO):
            return SkipReason.WRONG_KIND
        if not self.is_playable:
            return SkipReason.NOT_PLAYABLE
        return None

    @property
    def is_valid(self) -> bool:
        return self.invalid_reason() is None


class SkippedEntry(BaseModel):
    """A playlist entry that was excluded before the shuffle."""

    track: Track
    reason: SkipReason


class PlaylistRef(BaseModel):
    """A playlist as listed by a provider."""

    provider: str
    id: str
    name: str = ""
    description: str = ""
    #: Number of entries, or ``UNKNOWN_TRACK_COUNT`` when the service lists the
    #: playlist but will not say how big it is.
    track_count: int = 0
    owner: str = ""
    image_url: str = ""
    url: str = ""
    editable: bool = True
    #: False when the service shows this playlist but refuses to hand out its
    #: contents.  Spotify does that for every playlist the user neither owns nor
    #: collaborates on, editorial playlists included, so the UI has to say so
    #: rather than offer a deck it cannot deal.
    readable: bool = True
    #: Why it is not readable, in the interface's language.  Empty when it is.
    unreadable_reason: str = ""


class Device(BaseModel):
    """A playback target (Spotify Connect device, browser web player, ...)."""

    id: str
    name: str
    kind: str = "unknown"
    is_active: bool = False
    volume_percent: Optional[int] = None


class PlaybackState(BaseModel):
    """Normalised "what is playing right now" snapshot."""

    is_playing: bool = False
    track_id: Optional[str] = None
    progress_ms: int = 0
    duration_ms: int = 0
    device_id: Optional[str] = None
    device_name: str = ""
    #: True when the provider reported no active session at all.
    is_idle: bool = False

    @property
    def remaining_ms(self) -> int:
        if not self.duration_ms:
            return 0
        return max(0, self.duration_ms - self.progress_ms)


class PlayedTrack(BaseModel):
    """One entry from a service's recently-played history.

    This is what makes a deck trackable *without* true-shuffle driving
    playback: the listener plays the shuffled playlist in their own app, and we
    read back what they got through.
    """

    track_id: str
    played_at: str = ""


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

class RunState(BaseModel):
    """Snapshot of a shuffle run — the deck of cards."""

    run_id: int = 0
    user_id: int = 0
    provider: str = ""
    playlist_id: str = ""
    playlist_name: str = ""
    mode: RunMode = RunMode.UTILITY
    #: Provider-native track ids, in the exact order they will be played.
    order: List[str] = Field(default_factory=list)
    cursor: int = 0
    status: RunStatus = RunStatus.ACTIVE
    device_id: Optional[str] = None
    seed: Optional[int] = None
    created_at: str = ""
    updated_at: str = ""

    @property
    def total(self) -> int:
        return len(self.order)

    @property
    def remaining(self) -> int:
        return max(0, self.total - self.cursor)

    @property
    def current_track_id(self) -> Optional[str]:
        if 0 <= self.cursor < self.total:
            return self.order[self.cursor]
        return None

    @property
    def progress_pct(self) -> float:
        if not self.total:
            return 0.0
        return round(100.0 * min(self.cursor, self.total) / self.total, 1)

    def upcoming(self, count: int) -> List[str]:
        """The next *count* track ids after the cursor."""
        return self.order[self.cursor + 1 : self.cursor + 1 + count]


class RunEvent(BaseModel):
    """Audit trail entry — how the run actually progressed."""

    run_id: int = 0
    type: str = ""
    cursor: int = 0
    reason: Optional[str] = None
    detail: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""


# ---------------------------------------------------------------------------
# Export / import
# ---------------------------------------------------------------------------

EXPORT_VERSION = 2


class ExportPayload(BaseModel):
    """Portable run state.  OAuth tokens are NEVER included."""

    version: int = EXPORT_VERSION
    provider: str
    playlist_id: str
    playlist_name: str = ""
    mode: RunMode = RunMode.UTILITY
    order: List[str] = Field(default_factory=list)
    cursor: int = 0
    status: RunStatus = RunStatus.ACTIVE
    exported_at: str = ""

    model_config = {
        "json_schema_extra": {
            "description": "Run state export — OAuth tokens are NEVER included."
        }
    }
