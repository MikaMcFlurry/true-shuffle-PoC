"""Spotify connector — Web API + Spotify Connect remote control.

Spotify is the only one of the three mandatory services that lets a *server*
drive playback on a device the user is already listening on.  That is what
makes true Controller Mode possible here: the phone keeps playing through the
Spotify app, and true-shuffle decides what comes next.

Requires Spotify Premium for anything under "playback"; reading playlists and
Utility Mode work on free accounts.

Separate from that, and easy to miss: Spotify requires the *owner of the
developer app* to have Premium before an app in development mode works at all,
and every other account has to be allowlisted in the dashboard (max 5). So a
free-account listener can use Handoff — but only through an app whose owner
pays. Verified against the official docs, July 2026.

February 2026 API changes
-------------------------
This connector talks to a Development Mode client created after 11 February
2026, so it gets the reduced endpoint set with no grace period — the
postponement Spotify announced in March covers *existing* integrations only.
What that costs us, and how each cost is paid:

* ``GET /playlists/{id}/tracks`` and ``POST /playlists/{id}/tracks`` are gone;
  the replacements end in ``/items``, and the entry inside a page is called
  ``item`` rather than ``track``.  Page size dropped from 100 to 50.
* On the playlist object itself, ``tracks`` was renamed to ``items`` — and it
  is *absent* for playlists the user neither owns nor collaborates on.  Those
  playlists still list, but their contents never arrive, so we mark them
  unreadable up front instead of dealing an empty deck.
* ``POST /users/{id}/playlists`` is gone; ``POST /me/playlists`` replaces it and
  needs no user id, so creating a playlist is one request now, not two.
* Every batch read went away.  ``GET /tracks?ids=`` was fifty tracks per
  request; ``GET /tracks/{id}`` is one.  Hence the cache and the spacer below —
  since July 2026 the quota is counted per developer account, and running it
  dry takes out every client id at once.
* ``country`` and ``product`` are gone from ``GET /me``.  We can no longer tell
  a listener they need Premium *before* they press play, only when the player
  endpoint refuses, so that refusal now carries the explanation.

Sources: developer.spotify.com changelogs for February, March and July 2026,
and the February 2026 migration guide.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from base64 import urlsafe_b64encode
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple
from urllib.parse import urlencode

from app.config import get_settings
from core.models import (
    UNKNOWN_TRACK_COUNT,
    Device,
    PlaybackState,
    PlayedTrack,
    PlaylistRef,
    Track,
    TrackKind,
)
from providers import http
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderAuthError,
    ProviderCapabilities,
    ProviderContentUnavailable,
    ProviderError,
    ProviderNotConfigured,
    ProviderPaidTierRequired,
    ProviderQuotaError,
    TokenBundle,
)

logger = logging.getLogger(__name__)

_ACCOUNTS = "https://accounts.spotify.com"
_API = "https://api.spotify.com/v1"

#: Spotify's own cap on ``GET /playlists/{id}/items`` since February 2026.  It
#: was 100 before; asking for more now is a 400, not a silent clamp.
_ITEMS_PAGE_SIZE = 50

#: Least time between two single-track lookups.  ``GET /tracks?ids=`` used to
#: fetch fifty in one go, so a 1 500-track deck cost 30 requests; one at a time
#: it costs 1 500, and they must not all leave at once.
_TRACK_LOOKUP_INTERVAL = 0.06

#: One spacer for the whole connector, not one per user.  Since July 2026 the
#: development-mode quota is counted per *developer account*, so the five
#: allowlisted listeners share one allowance and must share one queue.
_TRACK_THROTTLE_KEY = "spotify:tracks"

http.set_throttle(_TRACK_THROTTLE_KEY, _TRACK_LOOKUP_INTERVAL)

#: How long a resolved track stays cached.  Track metadata does not move, and
#: the player polls the same handful of ids every few seconds — without this,
#: watching one deck would spend more quota than reading the playlist did.
_TRACK_CACHE_TTL = 3600.0

#: Bound on the cache so a long-lived process cannot grow without limit.
_TRACK_CACHE_MAX = 5000

#: Shown when Spotify lists a playlist but will not hand out its contents.
_FOREIGN_PLAYLIST_NOTE = (
    "Spotify gibt die Titel dieser Playlist nicht mehr heraus — seit Februar "
    "2026 nur noch für Playlists, die dir gehören oder an denen du mitarbeitest."
)

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


# ---------------------------------------------------------------------------
# Track metadata cache
# ---------------------------------------------------------------------------

#: ``track id → (expires_at, Track)``.  Process-local on purpose: this is a
#: single-process PoC, and a cache that outlives the process would have to
#: answer questions about invalidation that a PoC should not be asking.
_track_cache: Dict[str, Tuple[float, Track]] = {}


def _cache_get(track_id: str) -> Optional[Track]:
    entry = _track_cache.get(track_id)
    if entry is None:
        return None
    expires_at, track = entry
    if expires_at < time.monotonic():
        _track_cache.pop(track_id, None)
        return None
    return track


def _cache_put(track_id: str, track: Track) -> None:
    if len(_track_cache) >= _TRACK_CACHE_MAX:
        # Drop the entries closest to expiry rather than clearing everything:
        # a full flush would re-fetch the ids the player is polling right now.
        doomed = sorted(_track_cache, key=lambda k: _track_cache[k][0])
        for key in doomed[: _TRACK_CACHE_MAX // 4]:
            _track_cache.pop(key, None)
    _track_cache[track_id] = (time.monotonic() + _TRACK_CACHE_TTL, track)


def _cache_clear() -> None:
    """Test hook — the cache is deliberately global."""
    _track_cache.clear()


class SpotifyProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="spotify",
        display_name="Spotify",
        auth=AuthKind.OAUTH2_PKCE,
        playback=PlaybackControl.REMOTE_DEVICE,
        write_batch_size=100,
        # Halved in February 2026 along with the move to /items.
        read_page_size=_ITEMS_PAGE_SIZE,
        requires_paid_tier=True,
        # country and product left GET /me in February 2026.
        reports_account_tier=False,
        supports_queue_prefetch=True,
        supports_queue_read=True,
        supports_history_sync=True,
        brand_color="#1DB954",
        notes=[
            "Es muss nichts offen bleiben. true-shuffle steuert deine "
            "Spotify-App vom Server aus.",
            "Der Live-Modus übernimmt ein bestehendes Spotify-Gerät und braucht "
            "Premium. Öffne Spotify vorher irgendwo, damit es ein Gerät zu "
            "übernehmen gibt.",
            "Auf einem kostenlosen Konto nimm den Handoff-Modus: Das Fach wird "
            "als Playlist geschrieben, deine Position kommt aus deinem "
            "Hörverlauf zurück.",
            "Nur eigene Playlists lassen sich mischen. Seit Februar 2026 gibt "
            "Spotify die Titel fremder und redaktioneller Playlists nicht mehr "
            "heraus — „Discover Weekly“, Radiosender und alles von anderen "
            "Konten bleiben lesbar gelistet, aber leer. Kopier so eine Playlist "
            "in Spotify in dein Konto, dann geht sie.",
            "Spotify verrät nicht mehr, ob dein Konto Premium hat. Ob der "
            "Live-Modus geht, zeigt sich beim ersten Abspielversuch — dann "
            "steht hier, woran es lag.",
            "Achtung beim Einrichten: Spotify verlangt, dass der Besitzer der "
            "Developer-App selbst Premium hat, sonst funktioniert die App im "
            "Entwicklungsmodus gar nicht — auch Handoff nicht. Das ist Spotifys "
            "Regel, nicht unsere. Andere Konten müssen zusätzlich im Dashboard "
            "freigeschaltet werden (höchstens 5).",
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
        """Who this token belongs to.

        ``country`` and ``product`` were removed from ``GET /me`` in February
        2026, so market and tier stay empty for Spotify and the UI simply omits
        those rows.  Nothing may gate on ``product_tier`` for this connector —
        Premium is discovered from a player refusal, not from the profile.
        """
        me = await self._get(token, "/me")
        user_id = me.get("id") or me.get("account_id") or ""
        if not user_id:
            raise ProviderError("spotify: /me returned no account id")
        self._remember_user_id(token, user_id)
        return AccountIdentity(
            provider_user_id=user_id,
            display_name=me.get("display_name") or user_id,
        )

    # -- request helpers --------------------------------------------------

    def _headers(self, token: TokenBundle) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token.access_token}"}

    def _account_key(self, token: TokenBundle) -> str:
        return token.extra.get("account_key") or token.access_token[-12:]

    @staticmethod
    def _remember_user_id(token: TokenBundle, user_id: str) -> None:
        """Stash the Spotify user id on the bundle.

        Ownership decides whether a playlist's contents are readable at all,
        and asking ``/me`` once per playlist to find out would be absurd.
        """
        token.extra["spotify_user_id"] = user_id

    async def _user_id(self, token: TokenBundle) -> str:
        cached = token.extra.get("spotify_user_id")
        if cached:
            return str(cached)
        return (await self.identify(token)).provider_user_id

    async def _get(self, token: TokenBundle, path: str, **params: Any) -> Any:
        return await http.request(
            "GET", f"{_API}{path}", headers=self._headers(token),
            params=params or None, provider="spotify",
        )

    async def _player(
        self, token: TokenBundle, method: str, path: str, **kwargs: Any
    ) -> Any:
        """Player calls, serialised per account (see providers.http)."""
        async with http.sequential_lock(f"spotify:{self._account_key(token)}"):
            return await http.request(
                method, f"{_API}{path}", headers=self._headers(token),
                provider="spotify", **kwargs,
            )

    # -- library ----------------------------------------------------------

    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        me_id = await self._user_id(token)
        items: List[PlaylistRef] = []
        offset = 0
        while True:
            data = await self._get(token, "/me/playlists", limit=50, offset=offset)
            for p in data.get("items", []):
                if not p:
                    continue
                items.append(self._to_playlist_ref(p, me_id))
            if not data.get("next"):
                break
            offset += 50
        return items

    async def get_playlist(self, token: TokenBundle, playlist_id: str) -> PlaylistRef:
        me_id = await self._user_id(token)
        p = await self._get(token, f"/playlists/{playlist_id}")
        return self._to_playlist_ref(p, me_id)

    @staticmethod
    def _to_playlist_ref(p: Dict[str, Any], me_id: str) -> PlaylistRef:
        """Map one Spotify playlist object onto a :class:`PlaylistRef`.

        Two February 2026 changes meet here.  The size lives under ``items``
        now, not ``tracks`` — reading the old key is exactly why every playlist
        reported zero.  And the field is missing altogether on playlists the
        user does not own, so its absence means *unknown*, never *empty*.
        """
        owner = p.get("owner") or {}
        images = p.get("images") or []

        # Ownership, not the presence of a count, decides readability: Spotify
        # may list a size for a playlist whose contents it will still refuse.
        owned = bool(me_id) and owner.get("id") == me_id
        readable = owned or bool(p.get("collaborative"))

        block = p.get("items")
        if isinstance(block, dict) and isinstance(block.get("total"), int):
            track_count = block["total"]
        else:
            track_count = UNKNOWN_TRACK_COUNT

        return PlaylistRef(
            provider="spotify",
            id=p["id"],
            name=p.get("name", ""),
            description=p.get("description", ""),
            track_count=track_count,
            owner=owner.get("display_name") or owner.get("id", ""),
            image_url=images[0]["url"] if images else "",
            url=(p.get("external_urls") or {}).get("spotify", ""),
            editable=readable,
            readable=readable,
            unreadable_reason="" if readable else _FOREIGN_PLAYLIST_NOTE,
        )

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        """Page through ``GET /playlists/{id}/items``.

        Spotify answers a playlist the user neither owns nor collaborates on
        with ``403``, and that is turned into a stated reason rather than an
        empty deck.  A playlist that is genuinely empty is *not* the same thing
        and must keep saying so — which is why an empty page is left alone here
        and the ownership check happens before the read, on the PlaylistRef.
        """
        page_size = self.capabilities.read_page_size
        offset = 0
        while True:
            try:
                data = await self._get(
                    token, f"/playlists/{playlist_id}/items",
                    limit=page_size, offset=offset,
                    additional_types="track",
                )
            except ProviderContentUnavailable:
                raise
            except ProviderError as exc:
                if self._is_content_refusal(exc):
                    raise ProviderContentUnavailable(_FOREIGN_PLAYLIST_NOTE) from exc
                raise

            page = data.get("items") or []
            if page:
                yield [self._to_track(item) for item in page]
            if not data.get("next"):
                break
            offset += page_size

    @staticmethod
    def _is_content_refusal(exc: ProviderError) -> bool:
        """True when a read failed because we may not see the contents.

        Deliberately just the one status Spotify documents for this: *"A 403
        Forbidden status code will be returned if the user is neither the owner
        nor a collaborator of the playlist."*  A 404 is a playlist that is not
        there and a 5xx is an outage — reporting either as "not yours" would
        send someone looking for a permission problem they do not have.

        403 is overloaded, though: an exhausted quota and a rejected token can
        both arrive with that status, and both already carry a truer meaning by
        the time they get here.  Those keep it.
        """
        if isinstance(exc, (ProviderQuotaError, ProviderPaidTierRequired,
                            ProviderAuthError)):
            return False
        return exc.http_status == 403

    @staticmethod
    def _to_track(item: Dict[str, Any]) -> Track:
        # February 2026 renamed the entry inside a playlist page from ``track``
        # to ``item``.  The old key is still emitted as a deprecated alias, so
        # read the new one first and fall back rather than depending on either.
        t = item.get("item") or item.get("track") or {}
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
            # Spotify applies the token's own market to every read, so
            # ``is_playable`` is still populated — but ``available_markets``
            # and ``linked_from`` are gone and ``/me`` no longer reports the
            # market, so there is nothing left to cross-check it against.
            # Absent therefore means "no restriction reported", and a track
            # that turns out to be unplayable anyway is caught reactively, when
            # playback fails (AdvanceReason.PLAYBACK_FAILED).
            is_playable=bool(t.get("is_playable", True)),
            is_local=bool(item.get("is_local") or t.get("is_local")),
            kind=kind,
            artwork_url=images[-1]["url"] if images else "",
        )

    async def resolve_tracks(
        self, token: TokenBundle, track_ids: List[str]
    ) -> Dict[str, Track]:
        """Look up display metadata, one request per track.

        ``GET /tracks?ids=`` took fifty ids at a time and was removed in
        February 2026, so this is now the most expensive read in the connector.
        Three things keep it affordable: the cache (the player asks for the same
        window every few seconds), the spacer in ``providers.http``, and giving
        up on a single id instead of failing the whole lookup — a missing title
        in the "up next" list is a blank line, not a broken deck.
        """
        found: Dict[str, Track] = {}
        wanted: List[str] = []
        for track_id in track_ids:
            if not track_id or track_id in found or track_id in wanted:
                continue
            cached = _cache_get(track_id)
            if cached is not None:
                found[track_id] = cached
            else:
                wanted.append(track_id)

        for track_id in wanted:
            try:
                data = await http.request(
                    "GET", f"{_API}/tracks/{track_id}",
                    headers=self._headers(token), provider="spotify",
                    throttle_key=_TRACK_THROTTLE_KEY,
                )
            except (ProviderQuotaError, ProviderAuthError) as exc:
                # Not this track's problem, and the next nine ids would hit the
                # same wall.  Stop and hand back what is already known.
                logger.warning("spotify: stopping track lookups — %s", exc)
                break
            except ProviderError as exc:
                logger.info("spotify: track %s unavailable — %s", track_id, exc)
                continue
            if not data or not data.get("id"):
                continue
            track = self._to_track({"item": data})
            _cache_put(data["id"], track)
            found[data["id"]] = track
        return found

    async def create_playlist(
        self, token: TokenBundle, *, name: str, description: str = ""
    ) -> PlaylistRef:
        # POST /users/{id}/playlists is gone; /me/playlists needs no user id,
        # so the identify() round trip this used to make is gone with it.
        data = await http.request(
            "POST", f"{_API}/me/playlists",
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
                "POST", f"{_API}/playlists/{playlist_id}/items",
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

    async def get_queue(self, token: TokenBundle) -> Optional[Dict[str, Any]]:
        """``GET /me/player/queue`` — currently playing plus the queue, read-only.

        This is the forensic primitive the connector was missing: the Web API
        queue is append-only (add + read; no remove/clear/reorder exists), so
        reading it back is the only way to learn what previous appends actually
        did — and the precondition for any idempotent queue strategy.  Returns
        ``None`` when Spotify reports no playback session.
        """
        data = await self._player(token, "GET", "/me/player/queue")
        if not data:
            return None
        currently = (data.get("currently_playing") or {}).get("id")
        queue_ids = [
            t["id"] for t in (data.get("queue") or []) if t and t.get("id")
        ]
        return {"currently_playing_id": currently, "queue_ids": queue_ids}

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
