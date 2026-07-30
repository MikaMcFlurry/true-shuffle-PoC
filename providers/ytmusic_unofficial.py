"""YouTube Music — unofficial connector, off unless deliberately switched on.

Read this before enabling it.
=============================

The official connector (:mod:`providers.youtube`) uses the YouTube Data API v3.
That API cannot see your YouTube Music **library**, **Liked Music**, **uploads**
or **listening history**, because no public API exposes them. This connector
reaches all four — by driving `ytmusicapi`, a reverse-engineered client for
YouTube's *internal* API.

That is a real trade, and the honest version of it is:

* it can break at any time, with no notice and no deprecation window, because
  the endpoints it speaks to are not a published contract;
* using it is very likely against YouTube's terms of service, which matters a
  great deal more once money is involved;
* it authenticates with credentials copied out of a signed-in browser session,
  not with an OAuth grant the user can review and revoke in one place.

The project's own master handoff is explicit that a core product should not
depend on unofficial workarounds. So this ships as a **second, opt-in**
connector rather than as a replacement: the official one stays the default, and
enabling this is a deliberate act requiring both ``ENABLE_UNOFFICIAL_YTMUSIC``
and an installed ``ytmusicapi``.

``ytmusicapi`` is synchronous, so every call is handed to a worker thread.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Dict, List, Optional

from app.config import get_settings
from core.models import PlayedTrack, PlaylistRef, Track, TrackKind
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderAuthError,
    ProviderCapabilities,
    ProviderError,
    ProviderNotConfigured,
    TokenBundle,
)

#: Read this many playlist entries at once.  The internal API has no quota, so
#: the only cost is time.
_PAGE = 200

#: How many library playlists to ask for.  ``None`` means "all" in ytmusicapi.
_PLAYLIST_LIMIT = None


def _library_available() -> bool:
    try:
        import ytmusicapi  # noqa: F401
    except ImportError:
        return False
    return True


class UnofficialYouTubeMusicProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="ytmusic",
        display_name="YouTube Music (inoffiziell)",
        auth=AuthKind.PASTED,
        playback=PlaybackControl.WEB_PLAYER,
        write_batch_size=100,
        read_page_size=_PAGE,
        requires_paid_tier=False,
        supports_queue_prefetch=False,
        # The internal API does expose listening history, so unlike the
        # official connector a Handoff deck here can be tracked with nothing
        # of ours open.
        supports_history_sync=True,
        brand_color="#FF0033",
        experimental=True,
        notes=[
            "Inoffiziell: spricht YouTubes interne Schnittstelle über "
            "ytmusicapi. Kann jederzeit ohne Vorwarnung brechen und verstößt "
            "sehr wahrscheinlich gegen YouTubes Nutzungsbedingungen.",
            "Dafür erreichbar: deine Mediathek, „Liked Music“, Uploads und der "
            "Hörverlauf — alles, was über die offizielle API unsichtbar ist.",
            "Anmeldung über Zugangsdaten aus einer eingeloggten Browser-Sitzung, "
            "nicht über OAuth. Erzeugen mit: ytmusicapi browser",
            "Der offizielle YouTube-Music-Connector bleibt die Voreinstellung. "
            "Diesen hier nur einschalten, wenn du die Risiken tragen willst.",
        ],
    )

    # -- configuration ----------------------------------------------------

    def is_configured(self) -> bool:
        return not self.missing_config()

    def missing_config(self) -> List[str]:
        missing: List[str] = []
        if not get_settings().enable_unofficial_ytmusic:
            missing.append("ENABLE_UNOFFICIAL_YTMUSIC=true")
        if not _library_available():
            missing.append("pip install ytmusicapi")
        return missing

    # -- auth -------------------------------------------------------------

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        if self.missing_config():
            raise ProviderNotConfigured(
                "YouTube Music (inoffiziell) ist nicht aktiviert — es fehlt: "
                + ", ".join(self.missing_config())
            )
        return AuthStart(
            redirect_url=None,
            session_data={"state": state},
            browser_config={
                "kind": "pasted",
                "instructions": (
                    "Führe `ytmusicapi browser` aus und füge den Inhalt der "
                    "erzeugten browser.json hier ein."
                ),
            },
        )

    async def complete_browser_auth(self, payload: Dict[str, Any]) -> TokenBundle:
        """Accept the pasted ``browser.json`` blob and prove it works."""
        raw = (payload or {}).get("credential", "").strip()
        if not raw:
            raise ProviderError("ytmusic: keine Zugangsdaten eingefügt")

        try:
            headers = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "ytmusic: das ist kein gültiges JSON. Erwartet wird der Inhalt "
                "der von `ytmusicapi browser` erzeugten Datei."
            ) from exc
        if not isinstance(headers, dict):
            raise ProviderError("ytmusic: die Zugangsdaten müssen ein JSON-Objekt sein")

        bundle = TokenBundle(access_token=raw, expires_at=None)
        # Fail at connect time rather than halfway through a library read.
        await self.identify(bundle)
        return bundle

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        def _work(client) -> AccountIdentity:
            # Any authenticated call proves the credential; the library list is
            # the cheapest one that also confirms library scope.
            client.get_library_playlists(limit=1)
            return AccountIdentity(
                provider_user_id="ytmusic:browser-session",
                display_name="YouTube-Music-Konto",
                market="",
                product_tier="",
            )

        return await self._call(token, _work)

    # -- client -----------------------------------------------------------

    async def _call(self, token: TokenBundle, work) -> Any:
        """Run a blocking ytmusicapi call on a worker thread."""
        if not _library_available():
            raise ProviderNotConfigured("ytmusicapi ist nicht installiert")

        from ytmusicapi import YTMusic

        def _run() -> Any:
            try:
                client = YTMusic(json.loads(token.access_token))
            except Exception as exc:
                raise ProviderAuthError(
                    f"ytmusic: Zugangsdaten abgelehnt — {exc}. Neu erzeugen mit "
                    "`ytmusicapi browser`."
                ) from exc
            try:
                return work(client)
            except ProviderError:
                raise
            except Exception as exc:
                raise ProviderError(
                    f"ytmusic: interne Schnittstelle hat abgelehnt — {exc}. "
                    "Das passiert, wenn YouTube etwas geändert hat."
                ) from exc

        return await asyncio.to_thread(_run)

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        def _work(client) -> List[PlaylistRef]:
            return client.get_library_playlists(limit=_PLAYLIST_LIMIT)

        raw = await self._call(token, _work)
        items: List[PlaylistRef] = []
        for p in raw or []:
            pid = p.get("playlistId") or ""
            if not pid:
                continue
            thumbs = p.get("thumbnails") or []
            items.append(
                PlaylistRef(
                    provider="ytmusic",
                    id=pid,
                    name=p.get("title", ""),
                    description=p.get("description") or "",
                    track_count=_int_or_unknown(p.get("count")),
                    image_url=(thumbs[-1] or {}).get("url", "") if thumbs else "",
                    url=f"https://music.youtube.com/playlist?list={pid}",
                )
            )
        return items

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        def _work(client) -> List[Dict[str, Any]]:
            # "Liked Music" is its own endpoint rather than a normal playlist.
            if playlist_id in ("LM", "LIKED"):
                return (client.get_liked_songs(limit=5000) or {}).get("tracks", [])
            data = client.get_playlist(playlist_id, limit=None)
            return (data or {}).get("tracks", [])

        raw = await self._call(token, _work)
        tracks = [self._to_track(item) for item in raw or []]
        for i in range(0, len(tracks), _PAGE):
            yield tracks[i : i + _PAGE]

    @staticmethod
    def _to_track(item: Dict[str, Any]) -> Track:
        artists = item.get("artists") or []
        album = item.get("album") or {}
        thumbs = item.get("thumbnails") or []
        video_id = item.get("videoId") or ""
        # ytmusicapi reports availability directly, which the Data API cannot.
        available = item.get("isAvailable", True)
        return Track(
            provider="ytmusic",
            id=video_id,
            name=item.get("title", ""),
            artist=", ".join(a.get("name", "") for a in artists if a.get("name")),
            album=(album or {}).get("name", "") if isinstance(album, dict) else "",
            duration_ms=int(item.get("duration_seconds") or 0) * 1000,
            is_playable=bool(video_id) and bool(available),
            kind=TrackKind.VIDEO,
            artwork_url=(thumbs[0] or {}).get("url", "") if thumbs else "",
        )

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        def _work(client) -> Any:
            return client.create_playlist(name, description, privacy_status="PRIVATE")

        result = await self._call(token, _work)
        pid = result if isinstance(result, str) else str(result)
        return PlaylistRef(
            provider="ytmusic",
            id=pid,
            name=name,
            url=f"https://music.youtube.com/playlist?list={pid}",
        )

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        ids = [tid for tid in track_ids if tid]
        if not ids:
            return

        def _work(client) -> Any:
            # No per-track quota here, unlike the Data API's 50 units each.
            return client.add_playlist_items(playlist_id, ids, duplicates=False)

        await self._call(token, _work)

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        wanted = [tid for tid in track_ids if tid]
        if not wanted:
            return {}

        def _work(client) -> Dict[str, Track]:
            found: Dict[str, Track] = {}
            for tid in wanted:
                try:
                    data = client.get_song(tid) or {}
                except Exception:
                    continue
                details = data.get("videoDetails") or {}
                if not details.get("videoId"):
                    continue
                thumbs = ((details.get("thumbnail") or {}).get("thumbnails")) or []
                found[details["videoId"]] = Track(
                    provider="ytmusic",
                    id=details["videoId"],
                    name=details.get("title", ""),
                    artist=details.get("author", ""),
                    duration_ms=int(details.get("lengthSeconds") or 0) * 1000,
                    kind=TrackKind.VIDEO,
                    artwork_url=(thumbs[0] or {}).get("url", "") if thumbs else "",
                )
            return found

        return await self._call(token, _work)

    # -- history ----------------------------------------------------------

    async def get_recently_played(
        self, token: TokenBundle, limit: int = 50
    ) -> List[PlayedTrack]:
        """The listening history the public API does not expose.

        This is what lets a Handoff deck on YouTube Music be tracked with
        nothing of ours open — the one thing the official connector cannot do.
        """

        def _work(client) -> List[Dict[str, Any]]:
            return client.get_history()

        raw = await self._call(token, _work)
        played: List[PlayedTrack] = []
        for item in (raw or [])[:limit]:
            video_id = (item or {}).get("videoId")
            if video_id:
                played.append(
                    PlayedTrack(track_id=video_id, played_at=item.get("played", ""))
                )
        return played

    def browser_config(self, token: Optional[TokenBundle] = None) -> Dict[str, Any]:
        return {"player": "youtube-iframe"}

    def playlist_url(self, playlist_id: str) -> str:
        return f"https://music.youtube.com/playlist?list={playlist_id}"


def _int_or_unknown(value: Any) -> int:
    """ytmusicapi reports counts as strings, and sometimes not at all."""
    try:
        return int(str(value).replace(",", "").replace(".", "").split()[0])
    except (TypeError, ValueError, IndexError):
        return -1
