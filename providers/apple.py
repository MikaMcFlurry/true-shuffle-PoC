"""Apple Music connector — Apple Music API + MusicKit JS web player.

Apple has no server-side remote control: there is no "tell the iPhone what to
play" endpoint.  What Apple *does* give you is a first-class **browser**
player (MusicKit JS), and that is enough to deliver the full product promise —
the page holds the audio pipeline, and it reports every track end and every
skip back to the server, which owns the deck and the cursor.

Auth is therefore split:

* the **developer token** is an ES256 JWT minted here on the server from the
  MusicKit ``.p8`` private key (it is not a user credential — it identifies
  the app, and the browser needs it to boot MusicKit);
* the **Music User Token** is minted in the browser by ``music.authorize()``
  and posted back to us, then used server-side for library reads and writes.

Known limitation, stated up front: library items with no catalog equivalent
(personal uploads, some matched content) carry no ``catalogId`` and cannot be
queued by MusicKit.  They are reported as skipped entries with a reason rather
than silently dropped.
"""

from __future__ import annotations

import contextlib
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import jwt

from app.config import get_settings
from core.models import PlayedTrack, PlaylistRef, Track, TrackKind
from providers import http
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderCapabilities,
    ProviderError,
    ProviderNotConfigured,
    TokenBundle,
)

_API = "https://api.music.apple.com/v1"

#: Apple caps library list endpoints at 100 items per request.
_PAGE = 100
#: Apple rejects very large relationship arrays; keep writes conservative.
_WRITE_BATCH = 50


class AppleMusicProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="apple",
        display_name="Apple Music",
        auth=AuthKind.BROWSER_SDK,
        playback=PlaybackControl.WEB_PLAYER,
        write_batch_size=_WRITE_BATCH,
        read_page_size=_PAGE,
        requires_paid_tier=True,
        supports_queue_prefetch=False,
        supports_history_sync=True,
        brand_color="#FA243C",
        notes=[
            "Der Handoff-Modus braucht nichts Offenes: Das Fach wird in deine "
            "Mediathek geschrieben, deine Position kommt aus deinem "
            "Apple-Music-Hörverlauf zurück.",
            "Der Live-Modus spielt über MusicKit JS in diesem Browser-Tab, weil "
            "Apple keine serverseitige Fernsteuerung anbietet — er läuft also "
            "nur bei offenem Tab.",
            "Mediathek-Einträge ohne Apple-Music-Katalogeintrag (eigene "
            "Uploads) lassen sich nicht in die Warteschlange legen und werden "
            "als übersprungen gemeldet.",
        ],
    )

    # -- configuration ----------------------------------------------------

    def is_configured(self) -> bool:
        return not self.missing_config()

    def missing_config(self) -> List[str]:
        s = get_settings()
        missing: List[str] = []
        if not s.apple_team_id:
            missing.append("APPLE_TEAM_ID")
        if not s.apple_key_id:
            missing.append("APPLE_KEY_ID")
        if not s.apple_private_key_pem:
            missing.append("APPLE_PRIVATE_KEY (or APPLE_PRIVATE_KEY_PATH)")
        return missing

    # -- developer token --------------------------------------------------

    def developer_token(self) -> str:
        """Mint the ES256 JWT that identifies this app to Apple Music.

        Apple caps the lifetime at 180 days; we default to 150 so a deployed
        instance fails loudly during a maintenance window rather than at the
        exact expiry boundary.
        """
        s = get_settings()
        missing = self.missing_config()
        if missing:
            raise ProviderNotConfigured(
                "Apple Music is not configured — missing " + ", ".join(missing)
            )

        now = int(time.time())
        try:
            return jwt.encode(
                {
                    "iss": s.apple_team_id,
                    "iat": now,
                    "exp": now + s.apple_token_days * 24 * 3600,
                },
                s.apple_private_key_pem,
                algorithm="ES256",
                headers={"kid": s.apple_key_id, "alg": "ES256"},
            )
        except Exception as exc:
            raise ProviderNotConfigured(
                f"Apple Music developer token could not be signed: {exc}. "
                "Is APPLE_PRIVATE_KEY the contents of the MusicKit .p8 file?"
            ) from exc

    # -- auth -------------------------------------------------------------

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        """No redirect: the browser mints the user token with MusicKit JS."""
        return AuthStart(
            redirect_url=None,
            session_data={"state": state},
            browser_config={
                "developer_token": self.developer_token(),
                "app_name": "true-shuffle",
                "app_build": "0.2.0",
            },
        )

    async def complete_browser_auth(self, payload: Dict[str, Any]) -> TokenBundle:
        """Accept the Music User Token produced by ``music.authorize()``."""
        mut = (payload or {}).get("music_user_token", "").strip()
        if not mut:
            raise ProviderError("apple: no Music User Token supplied")

        bundle = TokenBundle(access_token=mut, expires_at=None)
        # Validate immediately — a bad MUT should fail at connect time, not
        # halfway through a 1 500-track read.
        await self.identify(bundle)
        return bundle

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        data = await self._get(token, "/me/storefront")
        entries = (data or {}).get("data") or []
        storefront = entries[0]["id"] if entries else ""
        name = entries[0].get("attributes", {}).get("name", "") if entries else ""
        return AccountIdentity(
            # Apple deliberately does not expose a stable user id; the
            # storefront plus the token is all we get.
            provider_user_id=f"apple:{storefront or 'unknown'}",
            display_name=name or "Apple Music account",
            market=storefront,
            product_tier="subscriber",
        )

    def browser_config(self, token: Optional[TokenBundle] = None) -> Dict[str, Any]:
        config: Dict[str, Any] = {
            "developer_token": self.developer_token(),
            "app_name": "true-shuffle",
            "app_build": "0.2.0",
        }
        if token and token.access_token:
            config["music_user_token"] = token.access_token
        return config

    # -- request helper ---------------------------------------------------

    def _headers(self, token: TokenBundle) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.developer_token()}",
            "Music-User-Token": token.access_token,
        }

    async def _get(self, token: TokenBundle, path: str, **params: Any) -> Any:
        return await http.request(
            "GET", f"{_API}{path}", headers=self._headers(token),
            params=params or None, provider="apple",
        )

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        items: List[PlaylistRef] = []
        offset = 0
        while True:
            data = await self._get(
                token, "/me/library/playlists", limit=_PAGE, offset=offset
            )
            page = (data or {}).get("data") or []
            for p in page:
                attrs = p.get("attributes") or {}
                artwork = (attrs.get("artwork") or {}).get("url", "")
                items.append(
                    PlaylistRef(
                        provider="apple",
                        id=p.get("id", ""),
                        name=attrs.get("name", ""),
                        description=(attrs.get("description") or {}).get("standard", ""),
                        # Apple does not return a track count on the list
                        # endpoint; -1 means "unknown until read".
                        track_count=-1,
                        image_url=_artwork(artwork, 160),
                        editable=bool(attrs.get("canEdit", True)),
                    )
                )
            if not page or not (data or {}).get("next"):
                break
            offset += _PAGE
        return items

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        offset = 0
        while True:
            data = await self._get(
                token, f"/me/library/playlists/{playlist_id}/tracks",
                limit=_PAGE, offset=offset,
            )
            page = (data or {}).get("data") or []
            yield [self._to_track(item) for item in page]
            if not page or not (data or {}).get("next"):
                break
            offset += _PAGE

    @staticmethod
    def _to_track(item: Dict[str, Any]) -> Track:
        attrs = item.get("attributes") or {}
        play = attrs.get("playParams") or {}
        # The catalog id is what MusicKit can queue.  Library-only items
        # (personal uploads) have none.
        catalog_id = str(play.get("catalogId") or play.get("purchasedId") or "")
        artwork = (attrs.get("artwork") or {}).get("url", "")
        return Track(
            provider="apple",
            # Fall back to the library id so an unplayable entry can still be
            # named in the skipped list instead of vanishing.
            id=catalog_id or str(item.get("id") or ""),
            name=attrs.get("name", ""),
            artist=attrs.get("artistName", ""),
            album=attrs.get("albumName", ""),
            duration_ms=int(attrs.get("durationInMillis") or 0),
            is_playable=bool(catalog_id),
            kind=TrackKind.TRACK,
            artwork_url=_artwork(artwork, 120),
        )

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        data = await http.request(
            "POST", f"{_API}/me/library/playlists",
            headers=self._headers(token),
            json_body={
                "attributes": {"name": name, "description": description},
                "relationships": {"tracks": {"data": []}},
            },
            provider="apple",
        )
        entries = (data or {}).get("data") or []
        if not entries:
            raise ProviderError("apple: playlist creation returned no id")
        created = entries[0]
        return PlaylistRef(
            provider="apple",
            id=created.get("id", ""),
            name=(created.get("attributes") or {}).get("name", name),
        )

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        for i in range(0, len(track_ids), _WRITE_BATCH):
            batch = [tid for tid in track_ids[i : i + _WRITE_BATCH] if tid]
            if not batch:
                continue
            await http.request(
                "POST", f"{_API}/me/library/playlists/{playlist_id}/tracks",
                headers=self._headers(token),
                json_body={"data": [{"id": tid, "type": "songs"} for tid in batch]},
                expect_json=False,
                provider="apple",
            )

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        """Look up catalog metadata so the player can show names and artwork."""
        identity_market = ""
        # Without a storefront we can still fall back to "us" for metadata.
        with contextlib.suppress(ProviderError):
            identity_market = (await self.identify(token)).market
        storefront = identity_market or "us"

        found: Dict[str, Track] = {}
        for i in range(0, len(track_ids), _PAGE):
            batch = [tid for tid in track_ids[i : i + _PAGE] if tid]
            if not batch:
                continue
            data = await self._get(
                token, f"/catalog/{storefront}/songs", ids=",".join(batch)
            )
            for song in (data or {}).get("data", []) or []:
                attrs = song.get("attributes") or {}
                artwork = (attrs.get("artwork") or {}).get("url", "")
                found[song["id"]] = Track(
                    provider="apple",
                    id=song["id"],
                    name=attrs.get("name", ""),
                    artist=attrs.get("artistName", ""),
                    album=attrs.get("albumName", ""),
                    duration_ms=int(attrs.get("durationInMillis") or 0),
                    artwork_url=_artwork(artwork, 120),
                )
        return found

    # -- history ----------------------------------------------------------

    async def get_recently_played(
        self, token: TokenBundle, limit: int = 50
    ) -> List[PlayedTrack]:
        """GET /me/recent/played/tracks — newest first.

        Apple caps this endpoint at **10 items per request** and 50 in total,
        so a full read is five calls.  That is the whole mechanism behind
        Handoff Mode on Apple: the listener plays the shuffled playlist in the
        Apple Music app with nothing of ours open, and we reconcile the deck
        from what comes back here.
        """
        wanted = min(50, max(1, limit))
        played: List[PlayedTrack] = []

        for offset in range(0, wanted, 10):
            data = await self._get(
                token, "/me/recent/played/tracks", limit=10, offset=offset
            )
            page = (data or {}).get("data") or []
            for song in page:
                attrs = song.get("attributes") or {}
                play = attrs.get("playParams") or {}
                track_id = str(play.get("catalogId") or song.get("id") or "")
                if track_id:
                    played.append(PlayedTrack(track_id=track_id))
            if len(page) < 10:
                break

        return played[:wanted]

    def playlist_url(self, playlist_id: str) -> str:
        return f"https://music.apple.com/library/playlist/{playlist_id}"


def _artwork(template: str, size: int) -> str:
    """Apple returns artwork URLs with ``{w}``/``{h}`` placeholders."""
    if not template:
        return ""
    return template.replace("{w}", str(size)).replace("{h}", str(size)).replace(
        "{f}", "jpg"
    )
