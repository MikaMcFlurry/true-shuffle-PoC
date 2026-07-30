"""YouTube Music connector — YouTube Data API v3 + IFrame Player.

Honest framing first, because the handoff explicitly warns against pretending
otherwise: **there is no official YouTube Music API.**  What exists is the
YouTube Data API v3, and YouTube Music playlists are YouTube playlists on the
same Google account, so they are reachable through it.  This connector uses
only official, documented endpoints — no scraping, no reverse-engineered
internal calls.

Two consequences the user is told about in the UI rather than in a footnote:

1. **Auto-generated playlists are invisible.**  "Liked Music", "Your
   Supermix", "Discover Mix" and friends are not exposed by the Data API.
   User-created playlists are.
2. **Utility Mode is quota-bound.**  ``playlistItems.insert`` costs 50 quota
   units per track against a default budget of 10 000 units per day, so
   writing a shuffled copy of a 1 500-track playlist would need 75 000 units
   and cannot work.  Live Mode reads the same playlist for roughly 60 units,
   so on YouTube the browser player is the primary path — and the connector
   refuses an impossible write instead of dying halfway through it.
"""

from __future__ import annotations

import time
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlencode

from app.config import get_settings
from core.models import PlaylistRef, Track, TrackKind
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
    ProviderQuotaError,
    TokenBundle,
)

_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"
_API = "https://www.googleapis.com/youtube/v3"

SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]

_PAGE = 50

#: Documented quota costs (units per call) — used for the pre-flight estimate.
QUOTA_LIST = 1
QUOTA_PLAYLIST_INSERT = 50
QUOTA_PLAYLIST_ITEM_INSERT = 50


class YouTubeMusicProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="youtube",
        display_name="YouTube Music",
        auth=AuthKind.OAUTH2_CODE,
        playback=PlaybackControl.WEB_PLAYER,
        write_batch_size=1,          # playlistItems.insert takes one item
        read_page_size=_PAGE,
        requires_paid_tier=False,
        supports_queue_prefetch=False,
        brand_color="#FF0033",
        notes=[
            "Live Mode plays in this browser tab through the official YouTube "
            "player — keep the tab open while listening.",
            "Only playlists you created are visible. YouTube's auto-generated "
            "mixes (Liked Music, Supermix, …) are not exposed by any public API.",
            "Copy Mode is limited by the YouTube API quota: each added track "
            "costs 50 of 10 000 daily units, so large playlists must use Live "
            "Mode instead.",
        ],
    )

    # -- configuration ----------------------------------------------------

    def is_configured(self) -> bool:
        return not self.missing_config()

    def missing_config(self) -> List[str]:
        s = get_settings()
        missing: List[str] = []
        if not s.youtube_client_id:
            missing.append("YOUTUBE_CLIENT_ID")
        if not s.youtube_client_secret:
            missing.append("YOUTUBE_CLIENT_SECRET")
        return missing

    # -- quota ------------------------------------------------------------

    def estimate_copy_quota(self, track_count: int) -> int:
        """Quota units a Utility-Mode copy of *track_count* tracks would cost."""
        reads = max(1, -(-track_count // _PAGE)) * QUOTA_LIST * 2
        return reads + QUOTA_PLAYLIST_INSERT + track_count * QUOTA_PLAYLIST_ITEM_INSERT

    def check_copy_quota(self, track_count: int) -> None:
        """Refuse a write that provably cannot finish within the daily budget."""
        budget = get_settings().youtube_daily_quota
        needed = self.estimate_copy_quota(track_count)
        if needed <= budget:
            return

        affordable = max(
            0, (budget - QUOTA_PLAYLIST_INSERT - 10) // QUOTA_PLAYLIST_ITEM_INSERT
        )
        read_only = needed - QUOTA_PLAYLIST_INSERT - track_count * QUOTA_PLAYLIST_ITEM_INSERT
        raise ProviderQuotaError(
            f"youtube: copying {track_count} tracks needs about {needed:,} quota "
            f"units but the daily budget is {budget:,}. YouTube's API allows "
            f"roughly {affordable} tracks per day this way — use Live Mode, which "
            f"reads the same playlist for about {read_only} units."
        )

    # -- auth -------------------------------------------------------------

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        s = get_settings()
        if self.missing_config():
            raise ProviderNotConfigured(
                "YouTube Music is not configured — missing "
                + ", ".join(self.missing_config())
            )
        params = {
            "client_id": s.youtube_client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "state": state,
            # offline + consent are what actually yields a refresh token.
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
        return AuthStart(redirect_url=f"{_AUTH}?{urlencode(params)}")

    async def complete_auth(
        self, *, code: str, redirect_uri: str, session_data: Dict[str, str]
    ) -> TokenBundle:
        s = get_settings()
        payload = await http.request(
            "POST", _TOKEN,
            data={
                "client_id": s.youtube_client_id,
                "client_secret": s.youtube_client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            provider="youtube",
        )
        return self._bundle(payload)

    async def refresh(self, token: TokenBundle) -> TokenBundle:
        if not token.refresh_token:
            raise ProviderError("youtube: no refresh token stored — reconnect required")
        s = get_settings()
        payload = await http.request(
            "POST", _TOKEN,
            data={
                "client_id": s.youtube_client_id,
                "client_secret": s.youtube_client_secret,
                "refresh_token": token.refresh_token,
                "grant_type": "refresh_token",
            },
            provider="youtube",
        )
        bundle = self._bundle(payload)
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
        data = await self._get(token, "/channels", part="snippet", mine="true")
        items = (data or {}).get("items") or []
        if not items:
            raise ProviderError(
                "youtube: this Google account has no YouTube channel. Open "
                "YouTube once to create one, then reconnect."
            )
        channel = items[0]
        snippet = channel.get("snippet") or {}
        return AccountIdentity(
            provider_user_id=channel.get("id", ""),
            display_name=snippet.get("title", ""),
            market=snippet.get("country", ""),
            product_tier="",
        )

    # -- request helper ---------------------------------------------------

    def _headers(self, token: TokenBundle) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token.access_token}"}

    async def _get(self, token: TokenBundle, path: str, **params: Any) -> Any:
        return await http.request(
            "GET", f"{_API}{path}", headers=self._headers(token),
            params={k: v for k, v in params.items() if v is not None},
            provider="youtube",
        )

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        items: List[PlaylistRef] = []
        page_token: Optional[str] = None
        while True:
            data = await self._get(
                token, "/playlists", part="snippet,contentDetails",
                mine="true", maxResults=_PAGE, pageToken=page_token,
            )
            for p in (data or {}).get("items", []) or []:
                snippet = p.get("snippet") or {}
                thumbs = (snippet.get("thumbnails") or {})
                thumb = (thumbs.get("medium") or thumbs.get("default") or {})
                items.append(
                    PlaylistRef(
                        provider="youtube",
                        id=p.get("id", ""),
                        name=snippet.get("title", ""),
                        description=snippet.get("description", ""),
                        track_count=(p.get("contentDetails") or {}).get("itemCount", 0),
                        owner=snippet.get("channelTitle", ""),
                        image_url=thumb.get("url", ""),
                        url=f"https://music.youtube.com/playlist?list={p.get('id', '')}",
                    )
                )
            page_token = (data or {}).get("nextPageToken")
            if not page_token:
                break
        return items

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        page_token: Optional[str] = None
        while True:
            data = await self._get(
                token, "/playlistItems", part="snippet,contentDetails,status",
                playlistId=playlist_id, maxResults=_PAGE, pageToken=page_token,
            )
            raw = (data or {}).get("items", []) or []
            tracks = [self._to_track(item) for item in raw]
            # A second call (1 unit) buys duration and, crucially, whether the
            # video may be embedded — an unembeddable video cannot be played by
            # our web player, so it must be reported, not silently skipped.
            await self._enrich(token, tracks)
            yield tracks
            page_token = (data or {}).get("nextPageToken")
            if not page_token:
                break

    @staticmethod
    def _to_track(item: Dict[str, Any]) -> Track:
        snippet = item.get("snippet") or {}
        details = item.get("contentDetails") or {}
        status = (item.get("status") or {}).get("privacyStatus", "")
        thumbs = snippet.get("thumbnails") or {}
        thumb = (thumbs.get("default") or {})
        video_id = details.get("videoId") or (snippet.get("resourceId") or {}).get("videoId", "")
        title = snippet.get("title", "")
        # Deleted or private entries keep their slot in the playlist but have
        # no playable video behind them.
        unavailable = title in ("Deleted video", "Private video") or status == "private"
        return Track(
            provider="youtube",
            id=video_id or "",
            name=title,
            artist=(snippet.get("videoOwnerChannelTitle")
                    or snippet.get("channelTitle") or ""),
            is_playable=bool(video_id) and not unavailable,
            kind=TrackKind.VIDEO,
            artwork_url=thumb.get("url", ""),
        )

    async def _enrich(self, token: TokenBundle, tracks: List[Track]) -> None:
        """Fill in duration and embeddability for a page of tracks."""
        ids = [t.id for t in tracks if t.id and t.is_playable]
        if not ids:
            return
        data = await self._get(
            token, "/videos", part="contentDetails,status", id=",".join(ids[:_PAGE])
        )
        info = {
            v["id"]: v for v in (data or {}).get("items", []) or [] if v.get("id")
        }
        for t in tracks:
            v = info.get(t.id)
            if v is None:
                if t.id in ids:
                    # Requested but not returned → removed or region-blocked.
                    t.is_playable = False
                continue
            status = v.get("status") or {}
            if status.get("embeddable") is False:
                t.is_playable = False
            t.duration_ms = _parse_iso8601_duration(
                (v.get("contentDetails") or {}).get("duration", "")
            )

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        found: Dict[str, Track] = {}
        for i in range(0, len(track_ids), _PAGE):
            batch = [tid for tid in track_ids[i : i + _PAGE] if tid]
            if not batch:
                continue
            data = await self._get(
                token, "/videos", part="snippet,contentDetails", id=",".join(batch)
            )
            for v in (data or {}).get("items", []) or []:
                snippet = v.get("snippet") or {}
                thumbs = snippet.get("thumbnails") or {}
                thumb = thumbs.get("default") or {}
                found[v["id"]] = Track(
                    provider="youtube",
                    id=v["id"],
                    name=snippet.get("title", ""),
                    artist=snippet.get("channelTitle", ""),
                    duration_ms=_parse_iso8601_duration(
                        (v.get("contentDetails") or {}).get("duration", "")
                    ),
                    kind=TrackKind.VIDEO,
                    artwork_url=thumb.get("url", ""),
                )
        return found

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        data = await http.request(
            "POST", f"{_API}/playlists",
            headers=self._headers(token),
            params={"part": "snippet,status"},
            json_body={
                "snippet": {"title": name, "description": description},
                "status": {"privacyStatus": "private"},
            },
            provider="youtube",
        )
        pid = (data or {}).get("id", "")
        return PlaylistRef(
            provider="youtube",
            id=pid,
            name=name,
            url=f"https://music.youtube.com/playlist?list={pid}",
        )

    async def add_tracks(
        self, token: TokenBundle, playlist_id: str, track_ids: List[str]
    ) -> None:
        """Insert tracks one at a time — the API has no batch endpoint.

        Callers should have run :meth:`check_copy_quota` first.
        """
        for video_id in track_ids:
            if not video_id:
                continue
            await http.request(
                "POST", f"{_API}/playlistItems",
                headers=self._headers(token),
                params={"part": "snippet"},
                json_body={
                    "snippet": {
                        "playlistId": playlist_id,
                        "resourceId": {"kind": "youtube#video", "videoId": video_id},
                    }
                },
                provider="youtube",
            )

    def browser_config(self, token: Optional[TokenBundle] = None) -> Dict[str, Any]:
        # The IFrame player needs no credential; it plays public, embeddable
        # videos by id.
        return {"player": "youtube-iframe"}

    def playlist_url(self, playlist_id: str) -> str:
        return f"https://music.youtube.com/playlist?list={playlist_id}"


def _parse_iso8601_duration(value: str) -> int:
    """``PT4M13S`` → milliseconds.  Returns 0 for anything unparseable."""
    if not value.startswith("PT"):
        return 0
    total = 0
    number = ""
    for ch in value[2:]:
        if ch.isdigit():
            number += ch
            continue
        if not number:
            continue
        amount = int(number)
        number = ""
        if ch == "H":
            total += amount * 3600
        elif ch == "M":
            total += amount * 60
        elif ch == "S":
            total += amount
    return total * 1000
