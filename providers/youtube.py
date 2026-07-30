"""YouTube Music connector — YouTube Data API v3 + IFrame Player.

Honest framing first, because the handoff explicitly warns against pretending
otherwise: **there is no official YouTube Music API.**  What exists is the
YouTube Data API v3, and YouTube Music playlists are YouTube playlists on the
same Google account, so they are reachable through it.  This connector uses
only official, documented endpoints — no scraping, no reverse-engineered
internal calls.

Two consequences the user is told about in the UI rather than in a footnote:

1. **What is reachable, precisely.**  Playlists *you created* — including the
   ones you created inside YouTube Music, since those are YouTube playlists on
   the same account.  What is **not** reachable through any public API: your
   YouTube Music library, "Liked Music", uploads, and the auto-generated mixes
   ("Supermix", "Discover Mix").  Playback is the YouTube player, not the
   YouTube Music player.
1b. **Music, not just video.**  A YouTube playlist can hold anything, so every
   entry is checked against YouTube's own Music category (10) — with an
   exemption for "<Artist> - Topic" channels, which are YouTube Music's own
   catalogue uploads.  Anything else is reported as ``not_music`` rather than
   dealt into a music deck.
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
from core.models import PlaylistRef, SkipReason, Track, TrackKind
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

#: YouTube's own category id for Music. An entry outside it is a talk, a
#: trailer or a lecture that happens to sit in a playlist — not a track.
_MUSIC_CATEGORY = "10"


def _de(value: int) -> str:
    """Group thousands the German way, for messages the listener reads."""
    return f"{value:,}".replace(",", ".")

#: YouTube Music's catalogue tracks are served by auto-generated
#: "<Artist> - Topic" channels. The suffix is plumbing, not an artist name.
_TOPIC_SUFFIX = " - Topic"

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
        # YouTube removed watch-history from the Data API years ago, and there
        # is no supported replacement.  Declaring this False is what stops the
        # UI from promising tab-free progress tracking here.
        supports_history_sync=False,
        brand_color="#FF0033",
        notes=[
            "Der Live-Modus spielt über den offiziellen YouTube-Player in "
            "diesem Browser-Tab. Der Tab muss beim Hören offen bleiben.",
            "YouTube ist der einzige Dienst ohne Hörverlauf-API. Ein Fach, das "
            "du in der YouTube-App spielst, kann seinen Fortschritt also nicht "
            "zurückmelden. Nur der Live-Modus zählt hier deine Position mit.",
            "Erreichbar über die YouTube Data API, den einzigen offiziellen Weg. "
            "YouTube Music hat keine eigene öffentliche API. Playlists, die "
            "du in YouTube Music angelegt hast, tauchen hier auf, weil sie "
            "YouTube-Playlists sind.",
            "Nicht erreichbar: deine YouTube-Music-Mediathek, „Liked Music“, "
            "Uploads und die automatisch erzeugten Mixe. Keine öffentliche API "
            "gibt sie heraus.",
            "Einträge, die keine Musik sind, kommen nicht ins Fach und werden "
            "gemeldet. Ein Fach bleibt Musik.",
            "Der Handoff-Modus ist durch das YouTube-Kontingent begrenzt: Jeder "
            "hinzugefügte Titel kostet 50 von 10 000 Einheiten pro Tag, große "
            "Playlists brauchen also den Live-Modus.",
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
            f"YouTube: {track_count} Titel zu schreiben kostet rund "
            f"{_de(needed)} Kontingent-Einheiten, das Tagesbudget sind aber "
            f"{_de(budget)}. So lassen sich pro Tag etwa {affordable} Titel "
            f"schreiben — nimm den Live-Modus, der dieselbe Playlist für "
            f"rund {read_only} Einheiten nur liest."
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
            artist=_artist_name(snippet.get("videoOwnerChannelTitle")
                                or snippet.get("channelTitle") or ""),
            is_playable=bool(video_id) and not unavailable,
            kind=TrackKind.VIDEO,
            artwork_url=thumb.get("url", ""),
        )

    async def _enrich(self, token: TokenBundle, tracks: List[Track]) -> None:
        """Fill in duration, embeddability and whether the entry is music.

        ``videos.list`` costs one quota unit whatever parts are requested, so
        asking for ``snippet`` as well is free and is what lets a YouTube
        playlist be read as *music* rather than as whatever happens to be in it.
        """
        ids = [t.id for t in tracks if t.id and t.is_playable]
        if not ids:
            return
        data = await self._get(
            token, "/videos", part="snippet,contentDetails,status",
            id=",".join(ids[:_PAGE]),
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

            snippet = v.get("snippet") or {}
            category = str(snippet.get("categoryId") or "")
            channel = snippet.get("channelTitle") or ""
            # A "- Topic" channel is YouTube Music's own catalogue upload, so it
            # is music even if the category is missing from the response.
            if category and category != _MUSIC_CATEGORY and not channel.endswith(_TOPIC_SUFFIX):
                t.exclude_reason = SkipReason.NOT_MUSIC
            if not t.artist and channel:
                t.artist = _artist_name(channel)

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
                    artist=_artist_name(snippet.get("channelTitle", "")),
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


def _artist_name(channel_title: str) -> str:
    """``Boards of Canada - Topic`` → ``Boards of Canada``."""
    if channel_title.endswith(_TOPIC_SUFFIX):
        return channel_title[: -len(_TOPIC_SUFFIX)]
    return channel_title


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
