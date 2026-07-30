"""Demo connector — the whole product, with nobody's music.

Why this exists
===============

Every real connector needs credentials, and two of the three need paperwork:
a Google Cloud project for YouTube, and for Apple Music a **paid** developer
account. That is a steep price for "I would like to see whether this works",
and it makes the difference between a test plan someone follows and one they
read.

So this connector implements the same :class:`~providers.base.MusicProvider`
contract against an in-memory library and a simulated listener. It exercises
every path the real ones do — OAuth round trip, paged reads, shuffling, the
deck, Live Mode with server-side auto-advance, Handoff Mode with history
reconciliation, skips, resume, export — without touching a network.

What it is not
--------------

It is not a streaming service, and the interface says so on every screen it
appears on. Nothing it reports is evidence that Spotify, Apple Music or
YouTube Music work; those must be verified with live credentials, and
``STATUS.md`` is where that gets recorded.

It is **off by default** and refuses to configure itself without
``ENABLE_DEMO_PROVIDER=true``.
"""

from __future__ import annotations

import time
from typing import AsyncIterator, Dict, List, Optional

from app.config import get_settings
from core.models import Device, PlaybackState, PlayedTrack, PlaylistRef, Track, TrackKind
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderCapabilities,
    ProviderNotConfigured,
    TokenBundle,
)

#: A demo track is over in twelve seconds. Long enough to watch the divider
#: sit still, short enough to watch it move without making a coffee.
TRACK_MS = 12_000

#: How fast the simulated listener works through a handed-off playlist. Faster
#: than the Live simulation, because the history loop polls once a minute and
#: nobody should have to wait an hour to see two cards reconcile.
HANDOFF_SECONDS_PER_TRACK = 8.0

#: Read this many entries per page, so the progress bar on a large playlist
#: has something to report.
_PAGE = 50

_ARTISTS = [
    ("Boards of Canada", ["Roygbiv", "An Eagle in Your Mind", "Olson", "Turquoise Hexagon Sun"]),
    ("Massive Attack", ["Teardrop", "Angel", "Unfinished Sympathy", "Safe from Harm"]),
    ("Portishead", ["Glory Box", "Roads", "Wandering Star", "Sour Times"]),
    ("Aphex Twin", ["Windowlicker", "Xtal", "Avril 14th", "Rhubarb"]),
    ("Burial", ["Archangel", "Near Dark", "Etched Headplate", "Raver"]),
    ("Four Tet", ["Angel Echoes", "Love Cry", "Two Thousand and Seventeen", "Baby"]),
    ("Bonobo", ["Kiara", "Cirrus", "Kong", "Break Apart"]),
    ("Jon Hopkins", ["Open Eye Signal", "Emerald Rush", "Luminous Beings", "Abandon Window"]),
]


def _library() -> List[Track]:
    """A deck big enough to be honest about scale.

    The primary user's playlist is around 1,500 tracks (``PRODUCT.md``), and a
    twelve-track demo hides every problem that only appears at real size — the
    crate, the paging progress, the shuffle quality, the queue prefetch.
    """
    tracks: List[Track] = []
    n = 0
    while len(tracks) < 1_482:
        artist, titles = _ARTISTS[n % len(_ARTISTS)]
        title = titles[(n // len(_ARTISTS)) % len(titles)]
        round_no = n // (len(_ARTISTS) * len(titles))
        tracks.append(
            Track(
                provider="demo",
                id=f"demo-{n:05d}",
                name=title if round_no == 0 else f"{title} ({round_no + 1})",
                artist=artist,
                album="Demo",
                duration_ms=TRACK_MS,
                kind=TrackKind.TRACK,
            )
        )
        n += 1
    return tracks


class DemoProvider(MusicProvider):
    """A complete streaming service that plays nothing."""

    capabilities = ProviderCapabilities(
        id="demo",
        display_name="Demo-Dienst",
        auth=AuthKind.OAUTH2_PKCE,
        playback=PlaybackControl.REMOTE_DEVICE,
        write_batch_size=100,
        read_page_size=_PAGE,
        requires_paid_tier=False,
        supports_queue_prefetch=True,
        # The Spotify shape: the server can drive playback *and* read a
        # listening history, so both modes are demonstrable.
        supports_history_sync=True,
        brand_color="#8a8f98",
        experimental=True,
        notes=[
            "Kein echter Streamingdienst. Dieser Connector simuliert eine "
            "Mediathek und einen Hörer, damit sich alle Funktionen ohne "
            "Zugangsdaten durchspielen lassen.",
            "Es wird nie Ton abgespielt. Im Live-Modus meldet der simulierte "
            "Player nach 12 Sekunden das Titelende, im Handoff-Modus arbeitet "
            "sich ein simulierter Hörer durch die geschriebene Playlist.",
            "Was hier funktioniert, ist kein Beleg dafür, dass Spotify, Apple "
            "Music oder YouTube Music funktionieren. Das steht in STATUS.md.",
            "Einschalten mit ENABLE_DEMO_PROVIDER=true in der .env.",
        ],
    )

    def __init__(self) -> None:
        self._tracks: Optional[List[Track]] = None
        self._by_id: Dict[str, Track] = {}
        # Live Mode: what the simulated device was told to play, and when.
        self._current: Optional[str] = None
        self._started_at: float = 0.0
        self._paused: bool = False
        self._held_ms: int = 0
        self._device: str = "demo-speaker"
        self._queue: List[str] = []
        # Handoff Mode: playlists we wrote, and when the listener started one.
        self._written: Dict[str, List[str]] = {}
        self._listening_since: Optional[float] = None
        self._listening_to: Optional[str] = None

    # -- configuration ----------------------------------------------------

    @property
    def tracks(self) -> List[Track]:
        if self._tracks is None:
            self._tracks = _library()
            self._by_id = {t.id: t for t in self._tracks}
        return self._tracks

    def is_configured(self) -> bool:
        return bool(get_settings().enable_demo_provider)

    def missing_config(self) -> List[str]:
        return [] if self.is_configured() else ["ENABLE_DEMO_PROVIDER=true"]

    # -- auth -------------------------------------------------------------

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        """Hand the browser straight back to our own callback.

        There is no third party to visit, but the rest of the flow — state
        check, token exchange, identify, encrypted storage — runs exactly as
        it does for a real service, so this tests that code rather than
        bypassing it.
        """
        if not self.is_configured():
            raise ProviderNotConfigured(
                "Der Demo-Dienst ist nicht eingeschaltet. Setz "
                "ENABLE_DEMO_PROVIDER=true in der .env und starte neu."
            )
        return AuthStart(
            redirect_url=f"{redirect_uri}?code=demo&state={state}",
            session_data={"code_verifier": "demo"},
        )

    async def complete_auth(self, *, code, redirect_uri, session_data) -> TokenBundle:
        return TokenBundle(access_token=f"demo-token-{code}", expires_at=None)

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        return AccountIdentity(
            provider_user_id="demo-user",
            display_name="Demo-Konto",
            market="DE",
            product_tier="demo",
        )

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        total = len(self.tracks)
        return [
            PlaylistRef(provider="demo", id="demo-all", name="Alles (Demo)",
                        description="Die ganze Demo-Mediathek.", track_count=total),
            PlaylistRef(provider="demo", id="demo-small", name="Kurzes Fach (Demo)",
                        description="12 Titel, zum schnellen Durchhören.",
                        track_count=12),
            PlaylistRef(provider="demo", id="demo-dirty", name="Mit Ausschuss (Demo)",
                        description="Enthält Doppelte und Nicht-Spielbares.",
                        track_count=20),
        ]

    def _playlist(self, playlist_id: str) -> List[Track]:
        if playlist_id == "demo-small":
            return self.tracks[:12]
        if playlist_id == "demo-dirty":
            # Deliberately dirty: duplicates and unplayable entries, so the
            # "nicht ins Fach gekommen" reporting has something to report.
            base = self.tracks[:14]
            broken = [
                Track(provider="demo", id="", name="Lokale Datei", artist="—"),
                Track(provider="demo", id="demo-x1", name="Nicht verfügbar",
                      artist="Demo", is_playable=False, duration_ms=TRACK_MS),
                Track(provider="demo", id="demo-x2", name="Eine Episode",
                      artist="Demo", kind=TrackKind.EPISODE, duration_ms=TRACK_MS),
            ]
            return [*base, *base[:3], *broken]
        return self.tracks

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        items = self._playlist(playlist_id)
        for i in range(0, len(items), _PAGE):
            yield items[i : i + _PAGE]

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        pid = f"demo-copy-{len(self._written) + 1}"
        self._written[pid] = []
        # A fresh handoff means a fresh listener, starting from the beginning.
        self._listening_since = time.monotonic()
        self._listening_to = pid
        return PlaylistRef(provider="demo", id=pid, name=name,
                           description=description,
                           url=f"http://127.0.0.1/demo/playlist/{pid}")

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        self._written.setdefault(playlist_id, []).extend(
            [tid for tid in track_ids if tid]
        )

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        known = {t.id: t for t in self.tracks}
        return {tid: known[tid] for tid in track_ids if tid in known}

    # -- playback (Live Mode) ---------------------------------------------

    async def list_devices(self, token: TokenBundle) -> List[Device]:
        return [
            Device(id="demo-speaker", name="Demo-Box (Wohnzimmer)",
                   kind="speaker", is_active=True),
            Device(id="demo-phone", name="Demo-Handy", kind="smartphone",
                   is_active=False),
        ]

    async def play(self, token, *, track_id, device_id=None, position_ms=0) -> None:
        self._current = track_id
        self._started_at = time.monotonic() - (position_ms / 1000.0)
        self._paused = False
        self._device = device_id or self._device
        # An explicit play replaces whatever the device was lined up to do.
        self._queue.clear()

    async def enqueue(self, token, *, track_id, device_id=None) -> None:
        self._queue.append(track_id)

    async def pause(self, token, *, device_id=None) -> None:
        # Freeze the clock where it stands, so resuming does not teleport.
        self._held_ms = self._elapsed_ms()
        self._paused = True

    def _elapsed_ms(self) -> int:
        if self._paused:
            return self._held_ms
        return int((time.monotonic() - self._started_at) * 1000)

    async def get_playback_state(self, token) -> Optional[PlaybackState]:
        """A simulated device that owns a queue, the way a real one does.

        This is the part that makes Live Mode demonstrable, and it has to work
        the way the engine expects: true-shuffle does **not** poll a clock and
        push the next track. It queues ahead, the service's own device plays
        through, and the watcher notices that the device has moved on to the
        card we queued. So this device must move on by itself.
        """
        if self._current is None:
            return PlaybackState(is_idle=True)

        elapsed = self._elapsed_ms()
        # Walk forward through the queue by whole tracks, exactly as a device
        # with a queue would.
        while elapsed >= TRACK_MS and self._queue:
            self._current = self._queue.pop(0)
            elapsed -= TRACK_MS
            self._started_at += TRACK_MS / 1000.0
            if self._paused:
                self._held_ms = elapsed

        return PlaybackState(
            is_playing=not self._paused,
            track_id=self._current,
            # With an empty queue the device sits at the end of the last track
            # rather than inventing progress that never happened.
            progress_ms=min(elapsed, TRACK_MS),
            duration_ms=TRACK_MS,
            device_id=self._device,
        )

    # -- history (Handoff Mode) -------------------------------------------

    async def get_recently_played(
        self, token: TokenBundle, limit: int = 50
    ) -> List[PlayedTrack]:
        """A simulated listener working through the handed-off playlist.

        This is the half of the product that needs nothing of ours open: the
        deck was written into the service, someone is playing it there, and
        true-shuffle reconciles the position from what the service reports.
        Without a simulation there is no way to see that path at all without
        a real account and real time passing.
        """
        if not self._listening_to or self._listening_since is None:
            return []
        order = self._written.get(self._listening_to, [])
        if not order:
            return []
        elapsed = time.monotonic() - self._listening_since
        played = min(len(order), int(elapsed // HANDOFF_SECONDS_PER_TRACK))
        if played <= 0:
            return []
        # Newest first, which is what every real service returns.
        return [PlayedTrack(track_id=tid) for tid in reversed(order[:played])][:limit]

    def playlist_url(self, playlist_id: str) -> str:
        return f"http://127.0.0.1/demo/playlist/{playlist_id}"
