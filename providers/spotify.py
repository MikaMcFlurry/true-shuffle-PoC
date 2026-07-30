"""Spotify connector — Web API + Spotify Connect remote control.

Spotify is the only one of the three mandatory services that lets a *server*
drive playback on a device the user is already listening on.  That is what
makes true Controller Mode possible here: the phone keeps playing through the
Spotify app, and true-shuffle decides what comes next.

Requires Spotify Premium for anything under "playback"; reading playlists and
Utility Mode work on free accounts.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from base64 import urlsafe_b64encode
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlencode

from app.config import get_settings
from core.models import Device, PlaybackState, PlayedTrack, PlaylistRef, Track, TrackKind
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

_ACCOUNTS = "https://accounts.spotify.com"
_API = "https://api.spotify.com/v1"

SCOPES = [
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-public",
    "playlist-modify-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    # Lets a deck advance from playback history when nothing of ours is open —
    # and is the only tracking a free account can get.
    "user-read-recently-played",
]


def _code_verifier(length: int = 96) -> str:
    return secrets.token_urlsafe(length)[:length]


def _code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class SpotifyProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="spotify",
        display_name="Spotify",
        auth=AuthKind.OAUTH2_PKCE,
        playback=PlaybackControl.REMOTE_DEVICE,
        write_batch_size=100,
        read_page_size=100,
        requires_paid_tier=True,
        supports_queue_prefetch=True,
        supports_history_sync=True,
        brand_color="#1DB954",
        notes=[
            "Es muss nichts offen bleiben — true-shuffle steuert deine "
            "Spotify-App vom Server aus.",
            "Der Live-Modus übernimmt ein bestehendes Spotify-Gerät und braucht "
            "Premium. Öffne Spotify vorher irgendwo, damit es ein Gerät zu "
            "übernehmen gibt.",
            "Auf einem kostenlosen Konto nimm den Handoff-Modus: Das Fach wird "
            "als Playlist geschrieben, deine Position kommt aus deinem "
            "Hörverlauf zurück.",
        ],
    )

    # -- configuration ----------------------------------------------------

    def is_configured(self) -> bool:
        return bool(get_settings().spotify_client_id)

    def missing_config(self) -> List[str]:
        return [] if self.is_configured() else ["SPOTIFY_CLIENT_ID"]

    # -- auth -------------------------------------------------------------

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        settings = get_settings()
        if not settings.spotify_client_id:
            raise ProviderNotConfigured("SPOTIFY_CLIENT_ID is not set")

        verifier = _code_verifier()
        params = {
            "client_id": settings.spotify_client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": " ".join(SCOPES),
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": _code_challenge(verifier),
        }
        return AuthStart(
            redirect_url=f"{_ACCOUNTS}/authorize?{urlencode(params)}",
            session_data={"code_verifier": verifier},
        )

    async def complete_auth(
        self, *, code: str, redirect_uri: str, session_data: Dict[str, str]
    ) -> TokenBundle:
        verifier = session_data.get("code_verifier")
        if not verifier:
            raise ProviderError("spotify: missing PKCE verifier — restart the connect flow")

        payload = await http.request(
            "POST",
            f"{_ACCOUNTS}/api/token",
            data={
                "client_id": get_settings().spotify_client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
            provider="spotify",
        )
        return self._bundle(payload)

    async def refresh(self, token: TokenBundle) -> TokenBundle:
        if not token.refresh_token:
            raise ProviderError("spotify: no refresh token stored — reconnect required")
        payload = await http.request(
            "POST",
            f"{_ACCOUNTS}/api/token",
            data={
                "client_id": get_settings().spotify_client_id,
                "grant_type": "refresh_token",
                "refresh_token": token.refresh_token,
            },
            provider="spotify",
        )
        bundle = self._bundle(payload)
        # Spotify does not always return a new refresh token.
        bundle.refresh_token = bundle.refresh_token or token.refresh_token
        return bundle

    @staticmethod
    def _bundle(payload: Dict[str, Any]) -> TokenBundle:
        return TokenBundle(
            access_token=payload["access_token"],
            refresh_token=payload.get("refresh_token"),
            expires_at=int(time.time()) + int(payload.get("expires_in", 3600)),
            scope=payload.get("scope", ""),
        )

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        me = await self._get(token, "/me")
        return AccountIdentity(
            provider_user_id=me["id"],
            display_name=me.get("display_name") or me["id"],
            market=me.get("country", ""),
            product_tier=me.get("product", ""),
        )

    # -- request helpers --------------------------------------------------

    def _headers(self, token: TokenBundle) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token.access_token}"}

    async def _get(self, token: TokenBundle, path: str, **params: Any) -> Any:
        return await http.request(
            "GET", f"{_API}{path}", headers=self._headers(token),
            params=params or None, provider="spotify",
        )

    async def _player(
        self, token: TokenBundle, method: str, path: str, **kwargs: Any
    ) -> Any:
        """Player calls, serialised per account (see providers.http)."""
        account = token.extra.get("account_key", token.access_token[-12:])
        async with http.sequential_lock(f"spotify:{account}"):
            return await http.request(
                method, f"{_API}{path}", headers=self._headers(token),
                provider="spotify", **kwargs,
            )

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        items: List[PlaylistRef] = []
        offset = 0
        while True:
            data = await self._get(token, "/me/playlists", limit=50, offset=offset)
            for p in data.get("items", []):
                if not p:
                    continue
                images = p.get("images") or []
                items.append(
                    PlaylistRef(
                        provider="spotify",
                        id=p["id"],
                        name=p.get("name", ""),
                        description=p.get("description", ""),
                        track_count=(p.get("tracks") or {}).get("total", 0),
                        owner=(p.get("owner") or {}).get("display_name", ""),
                        image_url=images[0]["url"] if images else "",
                        url=(p.get("external_urls") or {}).get("spotify", ""),
                    )
                )
            if not data.get("next"):
                break
            offset += 50
        return items

    async def get_playlist(self, token: TokenBundle, playlist_id: str) -> PlaylistRef:
        p = await self._get(token, f"/playlists/{playlist_id}")
        images = p.get("images") or []
        return PlaylistRef(
            provider="spotify",
            id=p["id"],
            name=p.get("name", ""),
            description=p.get("description", ""),
            track_count=(p.get("tracks") or {}).get("total", 0),
            owner=(p.get("owner") or {}).get("display_name", ""),
            image_url=images[0]["url"] if images else "",
            url=(p.get("external_urls") or {}).get("spotify", ""),
        )

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        offset = 0
        while True:
            data = await self._get(
                token, f"/playlists/{playlist_id}/tracks",
                limit=self.capabilities.read_page_size, offset=offset,
                additional_types="track",
            )
            yield [self._to_track(item) for item in data.get("items", [])]
            if not data.get("next"):
                break
            offset += self.capabilities.read_page_size

    @staticmethod
    def _to_track(item: Dict[str, Any]) -> Track:
        t = item.get("track") or {}
        kind_raw = t.get("type", "track")
        kind = TrackKind.EPISODE if kind_raw == "episode" else (
            TrackKind.TRACK if kind_raw == "track" else TrackKind.UNKNOWN
        )
        album = t.get("album") or {}
        images = album.get("images") or []
        return Track(
            provider="spotify",
            id=t.get("id") or "",
            name=t.get("name", ""),
            artist=", ".join(a.get("name", "") for a in (t.get("artists") or [])),
            album=album.get("name", ""),
            duration_ms=int(t.get("duration_ms") or 0),
            # ``is_playable`` is only present when a market is applied; absent
            # means "no restriction reported".
            is_playable=bool(t.get("is_playable", True)),
            is_local=bool(item.get("is_local") or t.get("is_local")),
            kind=kind,
            artwork_url=images[-1]["url"] if images else "",
        )

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        found: Dict[str, Track] = {}
        for i in range(0, len(track_ids), 50):
            batch = [tid for tid in track_ids[i : i + 50] if tid]
            if not batch:
                continue
            data = await self._get(token, "/tracks", ids=",".join(batch))
            for t in data.get("tracks", []) or []:
                if not t:
                    continue
                found[t["id"]] = self._to_track({"track": t})
        return found

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        identity = await self.identify(token)
        data = await http.request(
            "POST", f"{_API}/users/{identity.provider_user_id}/playlists",
            headers=self._headers(token),
            json_body={"name": name, "public": False, "description": description},
            provider="spotify",
        )
        return PlaylistRef(
            provider="spotify",
            id=data["id"],
            name=data.get("name", name),
            url=(data.get("external_urls") or {}).get("spotify", ""),
        )

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        size = self.capabilities.write_batch_size
        for i in range(0, len(track_ids), size):
            uris = [f"spotify:track:{tid}" for tid in track_ids[i : i + size]]
            await http.request(
                "POST", f"{_API}/playlists/{playlist_id}/tracks",
                headers=self._headers(token), json_body={"uris": uris},
                provider="spotify",
            )

    # -- playback ---------------------------------------------------------

    async def list_devices(self, token: TokenBundle) -> List[Device]:
        data = await self._player(token, "GET", "/me/player/devices")
        return [
            Device(
                id=d.get("id") or "",
                name=d.get("name", ""),
                kind=d.get("type", "unknown"),
                is_active=bool(d.get("is_active")),
                volume_percent=d.get("volume_percent"),
            )
            for d in (data or {}).get("devices", [])
            if d.get("id")
        ]

    async def play(
        self,
        token: TokenBundle,
        *,
        track_id: str,
        device_id: Optional[str] = None,
        position_ms: int = 0,
    ) -> None:
        body: Dict[str, Any] = {"uris": [f"spotify:track:{track_id}"]}
        if position_ms:
            body["position_ms"] = position_ms
        await self._player(
            token, "PUT", "/me/player/play",
            json_body=body,
            params={"device_id": device_id} if device_id else None,
            expect_json=False,
        )

    async def enqueue(
        self, token: TokenBundle, *, track_id: str, device_id: Optional[str] = None
    ) -> None:
        params: Dict[str, Any] = {"uri": f"spotify:track:{track_id}"}
        if device_id:
            params["device_id"] = device_id
        await self._player(
            token, "POST", "/me/player/queue", params=params, expect_json=False
        )

    async def pause(self, token: TokenBundle, *, device_id: Optional[str] = None) -> None:
        await self._player(
            token, "PUT", "/me/player/pause",
            params={"device_id": device_id} if device_id else None,
            expect_json=False,
        )

    async def get_playback_state(self, token: TokenBundle) -> Optional[PlaybackState]:
        data = await self._player(
            token, "GET", "/me/player", params={"additional_types": "track"}
        )
        if not data:
            return PlaybackState(is_idle=True)
        item = data.get("item") or {}
        device = data.get("device") or {}
        return PlaybackState(
            is_playing=bool(data.get("is_playing")),
            track_id=item.get("id"),
            progress_ms=int(data.get("progress_ms") or 0),
            duration_ms=int(item.get("duration_ms") or 0),
            device_id=device.get("id"),
            device_name=device.get("name", ""),
            is_idle=not item,
        )

    # -- history ----------------------------------------------------------

    async def get_recently_played(
        self, token: TokenBundle, limit: int = 50
    ) -> List[PlayedTrack]:
        """GET /me/player/recently-played — newest first, up to 50 entries.

        Works on free accounts, which is what makes Handoff Mode useful there:
        no playback control, but the deck still knows where you are.
        """
        data = await self._get(
            token, "/me/player/recently-played", limit=min(50, max(1, limit))
        )
        played: List[PlayedTrack] = []
        for item in (data or {}).get("items", []) or []:
            track = item.get("track") or {}
            if track.get("id"):
                played.append(
                    PlayedTrack(track_id=track["id"], played_at=item.get("played_at", ""))
                )
        return played

    def playlist_url(self, playlist_id: str) -> str:
        return f"https://open.spotify.com/playlist/{playlist_id}"
