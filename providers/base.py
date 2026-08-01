"""The connector contract every streaming service implements.

Design notes
------------
Streaming services differ in one structural way that matters more than any
API detail: **who holds the audio pipeline**.

* Spotify exposes a remote-control API — the server can tell an already-running
  Spotify app what to play.  We call that :attr:`PlaybackControl.REMOTE_DEVICE`.
* Apple Music and YouTube expose a *browser* player (MusicKit JS, the YouTube
  IFrame API).  The page holds the pipeline and reports events back to us.
  That is :attr:`PlaybackControl.WEB_PLAYER`.
* Some services only let us read and write playlists.  That is
  :attr:`PlaybackControl.NONE`, and only Utility Mode works there.

Everything else — pagination, batch sizes, whether a paid tier is required —
is declared as data in :class:`ProviderCapabilities` so the UI and the run
engine can adapt without special-casing provider names.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional

from core.models import Device, PlaybackState, PlayedTrack, PlaylistRef, Track

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ProviderError(Exception):
    """Base class for connector failures."""

    #: What *we* answer the browser with.
    status_code = 502

    #: What the *service* answered us with, when it was an HTTP response at all.
    #:
    #: Set by :mod:`providers.http`.  Connectors branch on this rather than on
    #: the message text, because a service that rewords an error must not be
    #: able to change what our code decides.
    http_status: Optional[int] = None


class ProviderNotConfigured(ProviderError):
    """The operator has not supplied credentials for this provider."""

    status_code = 503


class ProviderAuthError(ProviderError):
    """The user's tokens are missing, expired beyond repair, or rejected."""

    status_code = 401


class ProviderQuotaError(ProviderError):
    """The provider refused the request for quota / rate-limit reasons."""

    status_code = 429


class ProviderPaidTierRequired(ProviderError):
    """The account lacks the subscription this operation needs.

    Services used to let us read the tier up front and disable the feature
    before the user pressed anything.  Spotify removed ``product`` from
    ``GET /me`` in February 2026, so for that connector the only honest signal
    is the refusal itself — which is why this is an error class and not a
    capability flag.
    """

    status_code = 402


class ProviderNoActiveDevice(ProviderError):
    """A player command found no active device to land on (ERR-01).

    Spotify answers player commands with ``404 NO_ACTIVE_DEVICE`` once every
    client has been closed for a while.  The listener can fix this in
    seconds — but only if we say so instead of relaying a raw English 404.
    409 because the refusal is a state conflict, not a broken gateway.
    """

    status_code = 409


class ProviderContentUnavailable(ProviderError):
    """The item exists, but this account is not allowed to read its contents.

    Distinct from :class:`ProviderAuthError` (credentials are fine) and from a
    404 (the playlist is right there in the user's library).  Spotify stopped
    handing out the items of playlists the user neither owns nor collaborates
    on, and an empty deck is a worse answer than a stated reason.
    """

    status_code = 422


class Unsupported(ProviderError):
    """The provider cannot do this (e.g. remote playback on a web-only API)."""

    status_code = 400


#: Failures the listener can actually do something about, phrased in the
#: interface's language.  Everything else keeps the connector's own words: a
#: generic 502 is a bug report, and dressing it up in German would only hide
#: which service said what.
_USER_MESSAGES = {
    ProviderPaidTierRequired: (
        "Dieses Konto hat kein Abo. Der Live-Modus braucht eines — nimm den "
        "Handoff-Modus, der schreibt das Fach als Playlist und läuft auch ohne."
    ),
    ProviderQuotaError: (
        "Der Dienst nimmt gerade keine Anfragen mehr an — das Kontingent ist "
        "aufgebraucht. Warte eine Weile und versuch es dann noch einmal."
    ),
    ProviderNoActiveDevice: (
        "Kein aktives Gerät gefunden. Öffne Spotify auf deinem Gerät und "
        "starte dort kurz die Wiedergabe — dann übernimmt True Shuffle wieder."
    ),
}


def user_message(exc: BaseException) -> str:
    """A connector failure as the listener should read it.

    Both entry points need this — HTTP handlers and background jobs — and the
    listener does not care which one they were standing in when it broke.
    """
    for kind, text in _USER_MESSAGES.items():
        if isinstance(exc, kind):
            return text
    return str(exc)


# ---------------------------------------------------------------------------
# Capability declaration
# ---------------------------------------------------------------------------

class PlaybackControl(str, Enum):
    """Who owns the audio pipeline for this provider."""

    REMOTE_DEVICE = "remote_device"
    WEB_PLAYER = "web_player"
    NONE = "none"


class AuthKind(str, Enum):
    """How a user connects their account."""

    OAUTH2_PKCE = "oauth2_pkce"          # Spotify
    OAUTH2_CODE = "oauth2_code"          # Google / YouTube (confidential client)
    BROWSER_SDK = "browser_sdk"          # Apple Music: token minted in the page
    PASTED = "pasted"                    # credential the user pastes in by hand


@dataclass(frozen=True)
class ProviderCapabilities:
    """Static facts about a connector, surfaced to the UI and the engine."""

    id: str
    display_name: str
    auth: AuthKind
    playback: PlaybackControl

    read_playlists: bool = True
    create_playlist: bool = True
    #: Provider-imposed maximum of track ids per playlist-write request.
    write_batch_size: int = 100
    #: Page size for reading playlist items.
    read_page_size: int = 100
    #: Playback control requires a paid subscription tier.
    requires_paid_tier: bool = False
    #: The service will tell us the account's market and subscription tier.
    #:
    #: False means :attr:`AccountIdentity.market` and ``product_tier`` stay
    #: empty *by design*, not because something failed — Spotify removed
    #: ``country`` and ``product`` from ``GET /me`` in February 2026.  The UI
    #: needs the difference to say "not available" instead of showing a gap.
    reports_account_tier: bool = True
    #: ADR-002: the provider's play command accepts a whole *uris window* (a
    #: list of track ids plus an offset) and then plays through it on its own.
    #: This replaced ``supports_queue_prefetch`` — True Shuffle no longer
    #: touches the user's queue; the context window is the execution strategy.
    #: True for remote-control services (Spotify, Demo), False for web players
    #: (the page owns the pipeline and plays one title at a time).
    supports_context_window: bool = False
    #: The provider's playback queue can be read back (Spotify:
    #: ``GET /me/player/queue``).  Reading is the only queue introspection the
    #: Spotify Web API has — the queue itself is append-only (no remove, clear
    #: or reorder), so any dedup/reconciliation strategy starts with this flag.
    supports_queue_read: bool = False
    #: The provider exposes a recently-played history we can read back.
    #:
    #: This is what makes a deck trackable with **no browser tab open at all**:
    #: the listener plays the shuffled playlist in the service's own app, and
    #: the server reconciles how far they got from the history.
    supports_history_sync: bool = False
    #: Brand colour used only for the small service chip in the UI.
    brand_color: str = "#8a8f98"
    #: Honest, user-visible caveats.  Shown in the UI, not buried in a README.
    notes: List[str] = field(default_factory=list)
    #: Set when the connector is a documented placeholder rather than a
    #: working integration.
    experimental: bool = False

    @property
    def can_control_playback(self) -> bool:
        return self.playback is not PlaybackControl.NONE

    @property
    def supports_controller_mode(self) -> bool:
        return self.can_control_playback

    @property
    def live_mode_needs_open_tab(self) -> bool:
        """True when Live Mode only works while our page is open.

        Browser-SDK services own the audio pipeline inside the page, so closing
        the tab stops the music.  Remote-control services do not care.
        """
        return self.playback is PlaybackControl.WEB_PLAYER

    @property
    def tracks_progress_without_tab(self) -> bool:
        """True when a deck can advance with nothing of ours open."""
        return (
            self.playback is PlaybackControl.REMOTE_DEVICE
            or self.supports_history_sync
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "auth": self.auth.value,
            "playback": self.playback.value,
            "read_playlists": self.read_playlists,
            "create_playlist": self.create_playlist,
            "write_batch_size": self.write_batch_size,
            "requires_paid_tier": self.requires_paid_tier,
            "reports_account_tier": self.reports_account_tier,
            "supports_context_window": self.supports_context_window,
            "supports_queue_read": self.supports_queue_read,
            "supports_controller_mode": self.supports_controller_mode,
            "supports_history_sync": self.supports_history_sync,
            "live_mode_needs_open_tab": self.live_mode_needs_open_tab,
            "tracks_progress_without_tab": self.tracks_progress_without_tab,
            "brand_color": self.brand_color,
            "notes": list(self.notes),
            "experimental": self.experimental,
        }


# ---------------------------------------------------------------------------
# Auth payloads
# ---------------------------------------------------------------------------

@dataclass
class AuthStart:
    """Everything the app needs to begin a connect flow."""

    #: Where to send the browser.  ``None`` for browser-SDK providers, which
    #: are connected by a page rather than a redirect.
    redirect_url: Optional[str] = None
    #: Values to stash in the session until the callback comes back.
    session_data: Dict[str, str] = field(default_factory=dict)
    #: For BROWSER_SDK providers: config handed to the page (e.g. Apple's
    #: developer token).  Never contains a user credential.
    browser_config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TokenBundle:
    """Normalised credentials for one connected account."""

    access_token: str
    refresh_token: Optional[str] = None
    #: Absolute UNIX timestamp; ``None`` means "does not expire on its own".
    expires_at: Optional[int] = None
    scope: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
            "extra": self.extra,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> TokenBundle:
        return cls(
            access_token=data.get("access_token", ""),
            refresh_token=data.get("refresh_token"),
            expires_at=data.get("expires_at"),
            scope=data.get("scope", ""),
            extra=data.get("extra", {}) or {},
        )


@dataclass
class AccountIdentity:
    """Who the connected account belongs to."""

    provider_user_id: str
    display_name: str = ""
    #: Storefront (Apple) / market (Spotify) — affects track availability.
    market: str = ""
    #: e.g. "premium" / "free"; used to explain why Controller Mode is off.
    product_tier: str = ""


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------

class MusicProvider(abc.ABC):
    """One streaming service.

    Implementations are stateless: every method takes the caller's
    :class:`TokenBundle` so a single instance serves all users.  When a method
    refreshes credentials it returns the new bundle via ``on_refresh``.
    """

    capabilities: ProviderCapabilities

    # -- configuration ----------------------------------------------------

    @abc.abstractmethod
    def is_configured(self) -> bool:
        """True when the operator supplied the credentials this needs."""

    def missing_config(self) -> List[str]:
        """Names of the env vars that still need to be set."""
        return []

    # -- auth -------------------------------------------------------------

    @abc.abstractmethod
    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        """Start the connect flow."""

    async def complete_auth(
        self,
        *,
        code: str,
        redirect_uri: str,
        session_data: Dict[str, str],
    ) -> TokenBundle:
        """Exchange an OAuth callback for tokens."""
        raise Unsupported(f"{self.capabilities.id} does not use an OAuth callback")

    async def complete_browser_auth(self, payload: Dict[str, Any]) -> TokenBundle:
        """Accept a credential minted in the browser (Apple MusicKit)."""
        raise Unsupported(f"{self.capabilities.id} does not use browser auth")

    async def refresh(self, token: TokenBundle) -> TokenBundle:
        """Return a refreshed bundle.  Default: nothing to do."""
        return token

    def needs_refresh(self, token: TokenBundle, *, now: float, skew: int = 60) -> bool:
        return bool(token.expires_at) and token.expires_at < now + skew  # type: ignore[operator]

    @abc.abstractmethod
    async def identify(self, token: TokenBundle) -> AccountIdentity:
        """Fetch the connected account's identity."""

    def browser_config(self, token: Optional[TokenBundle] = None) -> Dict[str, Any]:
        """Non-secret configuration the front-end player needs."""
        return {}

    # -- library ----------------------------------------------------------

    @abc.abstractmethod
    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        """Every playlist the user can shuffle."""

    @abc.abstractmethod
    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        """Yield pages of tracks so huge playlists can stream with progress."""
        raise NotImplementedError
        yield []  # pragma: no cover - makes the signature an async generator

    async def get_playlist(self, token: TokenBundle, playlist_id: str) -> PlaylistRef:
        """Metadata for a single playlist.  Default: scan the user's list."""
        for pl in await self.list_playlists(token):
            if pl.id == playlist_id:
                return pl
        raise ProviderError(f"Playlist {playlist_id} not found")

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        raise Unsupported(f"{self.capabilities.id} cannot create playlists")

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        raise Unsupported(f"{self.capabilities.id} cannot write playlists")

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        """Look up display metadata for ids.  Default: nothing known."""
        return {}

    # -- history (providers with supports_history_sync) -------------------

    async def get_recently_played(
        self, token: TokenBundle, limit: int = 50
    ) -> List[PlayedTrack]:
        """Most recently played tracks, newest first.

        Only meaningful when
        :attr:`ProviderCapabilities.supports_history_sync` is set.  This is how
        a deck advances while nothing of ours is open: the listener plays the
        shuffled playlist in the service's own app, and we read back how far
        they got.
        """
        raise Unsupported(f"{self.capabilities.id} exposes no playback history")

    # -- playback (REMOTE_DEVICE providers) -------------------------------

    async def list_devices(self, token: TokenBundle) -> List[Device]:
        if self.capabilities.playback is not PlaybackControl.REMOTE_DEVICE:
            return []
        raise NotImplementedError

    async def play(
        self,
        token: TokenBundle,
        *,
        track_ids: List[str],
        offset_position: int = 0,
        device_id: Optional[str] = None,
        position_ms: int = 0,
    ) -> None:
        """Set the playback context to *track_ids*, starting at *offset_position*.

        ADR-002: ONE call carries the whole uris window.  The service then
        plays through the window on its own; within the window True Shuffle
        sends no further command.  Single-title playback is the degenerate
        case ``track_ids=[one_id]``.
        """
        raise Unsupported(f"{self.capabilities.id} has no remote playback control")

    async def skip_next(
        self, token: TokenBundle, *, device_id: Optional[str] = None
    ) -> None:
        """Advance the player to the next item of its current context.

        ADR-002: used for a TS-initiated skip while the provider is inside our
        window — one lightweight command instead of re-sending the window.
        Optional; callers fall back to :meth:`play` when this raises
        :class:`Unsupported`.
        """
        raise Unsupported(f"{self.capabilities.id} cannot skip to the next item")

    async def enqueue(
        self, token: TokenBundle, *, track_id: str, device_id: Optional[str] = None
    ) -> None:
        """Append one item to the provider's user queue.

        .. deprecated:: ADR-002
           True Shuffle no longer calls this anywhere — the additive queue
           prefetch provably multiplied the queue (SP-008), and the user's
           queue belongs to the user.  The method stays in the protocol only
           so connectors can describe the capability honestly; do not build
           new execution paths on it.
        """
        raise Unsupported(f"{self.capabilities.id} has no remote queue")

    async def pause(
        self, token: TokenBundle, *, device_id: Optional[str] = None
    ) -> None:
        raise Unsupported(f"{self.capabilities.id} has no remote playback control")

    async def get_playback_state(self, token: TokenBundle) -> Optional[PlaybackState]:
        """Poll what is playing.  ``None`` when the provider cannot tell us."""
        return None

    async def get_queue(self, token: TokenBundle) -> Optional[Dict[str, Any]]:
        """Read back the provider's playback queue.

        Only meaningful when :attr:`ProviderCapabilities.supports_queue_read`
        is set.  Returns ``{"currently_playing_id": Optional[str],
        "queue_ids": List[str]}``, or ``None`` when there is no playback
        session to read.  This is a *read* — the Spotify Web API offers no way
        to remove, clear or reorder queue entries, so observing the queue is
        the whole toolbox.
        """
        raise Unsupported(f"{self.capabilities.id} cannot read back its queue")

    # -- misc -------------------------------------------------------------

    def playlist_url(self, playlist_id: str) -> str:
        return ""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} id={self.capabilities.id}>"
