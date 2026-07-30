"""Shared fixtures.

Every test gets its own temporary database and a settings cache that has been
cleared, so tests never see each other's state.
"""

from __future__ import annotations

import os
from typing import AsyncIterator, Dict, List, Optional

TEST_SECRET = "test-secret-key-not-a-default-value"

# Set before anything imports app.main: FastAPI's SessionMiddleware captures
# the signing secret when the module is imported, so a fixture that runs later
# would leave the middleware signing with the "change-me" default.
os.environ["SECRET_KEY"] = TEST_SECRET

import pytest
import pytest_asyncio

from core.models import (
    UNKNOWN_TRACK_COUNT,
    Device,
    PlaybackState,
    PlayedTrack,
    PlaylistRef,
    Track,
    TrackKind,
)

#: What a connector says when a service lists a playlist but withholds its
#: contents — Spotify's rule for everything the listener does not own.
FOREIGN_PLAYLIST_REASON = (
    "Dieser Dienst gibt die Titel dieser Playlist nicht heraus — nur eigene "
    "Playlists lassen sich lesen."
)
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderCapabilities,
    TokenBundle,
)


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch, tmp_path):
    """Point every test at a throwaway database and a real secret key."""
    from app.config import get_settings

    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SECRET_KEY", TEST_SECRET)
    monkeypatch.setenv("BASE_URL", "http://testserver")
    monkeypatch.setenv("WATCHER_POLL_SECONDS", "0.01")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def database():
    """An initialised database, torn down afterwards."""
    from app.db import close_db, init_db

    db = await init_db()
    try:
        yield db
    finally:
        await close_db()


# ---------------------------------------------------------------------------
# A fake connector, so API tests never touch the network
# ---------------------------------------------------------------------------

class FakeProvider(MusicProvider):
    """In-memory provider standing in for a real streaming service."""

    def __init__(
        self,
        provider_id: str = "fake",
        playback: PlaybackControl = PlaybackControl.REMOTE_DEVICE,
        *,
        history_sync: bool = False,
        reports_account_tier: bool = True,
    ) -> None:
        self.capabilities = ProviderCapabilities(
            id=provider_id,
            display_name=f"Fake {provider_id}",
            auth=AuthKind.OAUTH2_PKCE,
            playback=playback,
            write_batch_size=10,
            read_page_size=4,
            supports_queue_prefetch=playback is PlaybackControl.REMOTE_DEVICE,
            supports_history_sync=history_sync,
            reports_account_tier=reports_account_tier,
        )
        self.reports_account_tier = reports_account_tier
        self.tracks: List[Track] = [
            Track(provider=provider_id, id=f"t{i}", name=f"Track {i}",
                  artist="Artist", duration_ms=180_000)
            for i in range(12)
        ]
        self.played: List[str] = []
        self.queued: List[str] = []
        self.created: Dict[str, List[str]] = {}
        self.state = PlaybackState(is_idle=True)
        self.fail_enqueue = False
        #: What ``get_recently_played`` will report, newest first.
        self.history: List[str] = []

    # -- config / auth --
    def is_configured(self) -> bool:
        return True

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        return AuthStart(redirect_url=f"https://fake/authorize?state={state}",
                         session_data={"code_verifier": "v"})

    async def complete_auth(self, *, code, redirect_uri, session_data) -> TokenBundle:
        return TokenBundle(access_token=f"token-{code}")

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        # A connector that cannot read the tier leaves both blank, exactly as
        # Spotify's does since country/product left GET /me.
        if not self.reports_account_tier:
            return AccountIdentity(
                provider_user_id="fake-user", display_name="Fake User",
            )
        return AccountIdentity(
            provider_user_id="fake-user", display_name="Fake User",
            market="DE", product_tier="premium",
        )

    # -- library --
    async def list_playlists(self, token) -> List[PlaylistRef]:
        return [
            PlaylistRef(provider=self.capabilities.id, id="pl1",
                        name="Everything", track_count=len(self.tracks)),
            # The Spotify shape since February 2026: listed, sized unknown, and
            # its contents withheld because the listener does not own it.
            PlaylistRef(provider=self.capabilities.id, id="pl-foreign",
                        name="Radio Someone Else",
                        track_count=UNKNOWN_TRACK_COUNT, owner="someone-else",
                        readable=False, editable=False,
                        unreadable_reason=FOREIGN_PLAYLIST_REASON),
        ]

    async def get_playlist(self, token, playlist_id) -> PlaylistRef:
        for playlist in await self.list_playlists(token):
            if playlist.id == playlist_id:
                return playlist
        from providers.base import ProviderError
        raise ProviderError(f"fake: no playlist {playlist_id}")

    async def iter_playlist_tracks(self, token, playlist_id) -> AsyncIterator[List[Track]]:
        if playlist_id == "pl-foreign":
            from providers.base import ProviderContentUnavailable
            raise ProviderContentUnavailable(FOREIGN_PLAYLIST_REASON)
        size = self.capabilities.read_page_size
        for i in range(0, len(self.tracks), size):
            yield self.tracks[i : i + size]

    async def create_playlist(self, token, *, name, description="") -> PlaylistRef:
        pid = f"copy-{len(self.created)}"
        self.created[pid] = []
        return PlaylistRef(provider=self.capabilities.id, id=pid, name=name)

    async def add_tracks(self, token, playlist_id, track_ids) -> None:
        self.created.setdefault(playlist_id, []).extend(track_ids)

    async def resolve_tracks(self, token, track_ids) -> Dict[str, Track]:
        known = {t.id: t for t in self.tracks}
        return {tid: known[tid] for tid in track_ids if tid in known}

    # -- playback --
    async def list_devices(self, token) -> List[Device]:
        return [Device(id="dev1", name="Fake Speaker", kind="speaker", is_active=True)]

    async def play(self, token, *, track_id, device_id=None, position_ms=0) -> None:
        self.played.append(track_id)
        self.state = PlaybackState(
            is_playing=True, track_id=track_id, progress_ms=0,
            duration_ms=180_000, device_id=device_id,
        )

    async def enqueue(self, token, *, track_id, device_id=None) -> None:
        if self.fail_enqueue:
            from providers.base import ProviderError
            raise ProviderError("fake: queue is full")
        self.queued.append(track_id)

    async def pause(self, token, *, device_id=None) -> None:
        self.state = PlaybackState(is_playing=False, track_id=self.state.track_id)

    async def get_playback_state(self, token) -> Optional[PlaybackState]:
        return self.state

    async def get_recently_played(self, token, limit: int = 50) -> List[PlayedTrack]:
        return [PlayedTrack(track_id=tid) for tid in self.history[:limit]]


@pytest.fixture
def fake_provider(monkeypatch):
    """Register a fake connector under the id ``fake``."""
    from providers import registry

    provider = FakeProvider()
    monkeypatch.setitem(registry._PROVIDERS, "fake", provider)
    return provider


@pytest.fixture
def fake_tierless_provider(monkeypatch):
    """A connector whose service stopped reporting market and subscription tier.

    That is Spotify since February 2026, and the connect page has to stay
    correct without those two rows.
    """
    from providers import registry

    provider = FakeProvider("faketier", reports_account_tier=False)
    monkeypatch.setitem(registry._PROVIDERS, "faketier", provider)
    return provider


@pytest.fixture
def fake_web_provider(monkeypatch):
    """A browser-player connector (Apple/YouTube shaped)."""
    from providers import registry

    provider = FakeProvider("fakeweb", PlaybackControl.WEB_PLAYER)
    monkeypatch.setitem(registry._PROVIDERS, "fakeweb", provider)
    return provider


@pytest.fixture
def fake_history_provider(monkeypatch):
    """A connector that cannot be remote-controlled but exposes a history.

    This is the Apple-Music shape, and the one that makes Handoff Mode work
    with no browser tab open.
    """
    from providers import registry

    provider = FakeProvider("fakehist", PlaybackControl.WEB_PLAYER, history_sync=True)
    monkeypatch.setitem(registry._PROVIDERS, "fakehist", provider)
    return provider


@pytest.fixture
def track_factory():
    def make(track_id: str, **kwargs) -> Track:
        kwargs.setdefault("provider", "fake")
        kwargs.setdefault("name", track_id)
        kwargs.setdefault("kind", TrackKind.TRACK)
        return Track(id=track_id, **kwargs)

    return make
