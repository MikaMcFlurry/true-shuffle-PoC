"""An honest Spotify player simulator for queue forensics.

Purpose
-------
Live credentials do not exist in this environment (Live gate: BLOCKED), so the
queue-duplication defect (SP-008) and the "Titel 6 = Titel 1" hypothesis are
made provable at evidence class **VERIFIED_AUTOMATED**: real app code
(``app/runs.py::_apply``, watcher-shaped advance sequences) runs unchanged
against this simulator, whose semantics are split explicitly into *documented
facts* and *declared assumptions*.

Documented facts modelled here (source: ``docs/ts-fable-01/PHASE0_REAUDIT.md``
§BASE-05, retrieved live 2026-07-31)
------------------------------------------------------------------------------
* The queue is **append-only**: ``POST /me/player/queue`` adds exactly one
  item, ``GET /me/player/queue`` reads it back — there is no remove, clear or
  reorder.  The simulator therefore offers no way to delete queue entries.
* ``PUT /me/player/play`` accepts ``context_uri`` **or** a ``uris`` array,
  plus ``offset`` and ``position_ms`` — a complete "set the order" primitive.
  ``offset`` is an **object** (``{"position": N}``); an out-of-range position
  is an error, not a silent clamp.
* Player endpoints answer **429 with Retry-After** under quota pressure
  (rolling 30 s window); injectable here via ``rate_limit_every`` /
  ``fail_next_with_429``.  BASE-05 documents the window for the API as a
  whole; whether *reads* count against it is switchable
  (``rate_limit_reads``), so the quota model can be exercised both ways.
* ``GET /me/player`` returns **204 (no content)** when there is no active
  device; modelled as ``None`` from :meth:`SimulatedSpotifyPlayer.get_playback_state`.
* Spotify warns that the **order of execution of combined player calls is not
  guaranteed** — the *fact* of non-guarantee is documented; concrete
  interleavings are assumption AN-3 below.

Declared assumptions (live verification pending — see LIVE_TEST_GUIDE.md)
------------------------------------------------------------------------------
AN-1  ``play(uris=[...])`` replaces the playback **context** but does **not**
      clear manually queued items.  Consistent with the append-only queue
      model (no clear endpoint exists), but the interaction of a play override
      with an already-filled queue is not documented → assumption.
      **Testable in both directions** via the constructor flag
      ``clear_queue_on_play`` (default ``False`` = AN-1 holds; ``True`` =
      AN-1 negated: a play override drops the manual queue).  Live: LT-7.
AN-2  What happens when the queue **and** the context are both exhausted
      (the "Titel 6 = Titel 1" candidate mechanism) is not documented.
      Configurable via ``exhausted_context_policy``:
      ``'replay_context'`` — the context restarts from its first item;
      ``'stop'``           — playback stops (idle).
      Both are testable; neither is asserted as live truth.  Live: LT-1.
AN-3  Latency and reordering between commands are injectable
      (``command_latency_ms``, ``swap_next_two()``) because Spotify documents
      the non-guarantee but not the actual interleavings.
AN-4  ``get_queue()`` blends the manual queue (first) with the upcoming
      context continuation — matching how the live endpoint is commonly
      observed to behave, but the exact composition is not documented.
AN-5  The user queue plays **before** the context continues (manually queued
      items pre-empt the context).  Real-Spotify-plausible and consistently
      observed, but NOT part of the BASE-05 documented facts — the entire
      queue-multiplication mechanism rests on it.  Live: LT-10.
AN-6  ``POST /me/player/queue`` accepts the **same URI multiple times** as
      separate entries (no dedup).  Silently load-bearing for the duplication
      proof: were the live API to collapse identical URIs, SP-008 would shrink
      to mis-ordering + wasted commands.  Live: LT-11.
AN-7  Player *commands* without any active device fail with
      **404 NO_ACTIVE_DEVICE** (play, enqueue, next, pause alike), and
      ``GET /me/player/queue`` yields no usable body (modelled as ``None``).
      BASE-05 only documents the 204 for ``GET /me/player``; the 404 for
      commands and the queue-read behaviour are assumptions.  Live: LT-12.

Additional deliberate simplifications (not Spotify claims): enqueueing while
nothing is playing parks the item in the queue instead of starting playback,
and a rewritten registered context does not affect an already-playing context
(contexts are snapshotted at ``play`` time).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

from core.models import Device, PlaybackState, PlaylistRef, Track
from providers.base import (
    AccountIdentity,
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderCapabilities,
    ProviderError,
    ProviderNoActiveDevice,
    ProviderQuotaError,
    TokenBundle,
)

DEFAULT_DURATION_MS = 180_000


class SimRateLimited(ProviderQuotaError):
    """An injected 429 with a Retry-After, as the live API would answer."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(f"simulated 429 — Retry-After: {retry_after_s}s")
        self.retry_after_s = retry_after_s
        self.http_status = 429


class SimNoActiveDevice(ProviderNoActiveDevice):
    """404 NO_ACTIVE_DEVICE — a player command without any active device.

    Teständerung 2026-08-01 (dokumentierte fachliche Begründung, ERR-01):
    subclasst jetzt die neue Produktions-Fehlerklasse
    ``ProviderNoActiveDevice`` — der Simulator modelliert exakt die
    Bedingung, für die die Klasse eingeführt wurde, und die Fehlerwege
    (409 + deutsche Geräteaktion) laufen damit über denselben Typ wie live.
    """

    def __init__(self) -> None:
        super().__init__("simulated 404 — NO_ACTIVE_DEVICE")
        self.http_status = 404


def _uri_to_id(uri: str) -> str:
    return uri.rsplit(":", 1)[-1]


@dataclass
class _PendingCommand:
    due_ms: int
    kind: str
    payload: Dict[str, Any] = field(default_factory=dict)


class SimulatedSpotifyPlayer:
    """One simulated Spotify Connect device with an API-shaped surface.

    Time is explicit: nothing happens until :meth:`tick` moves the clock.
    Commands (``play``, ``add_to_queue``, ``next``, ``pause``) are submitted
    through an intake that can inject 429s (documented behaviour), latency and
    reordering (AN-3).  Views (:meth:`get_playback_state`,
    :meth:`get_queue`) mirror the live API shapes.
    """

    def __init__(
        self,
        *,
        track_durations_ms: Optional[Dict[str, int]] = None,
        default_duration_ms: int = DEFAULT_DURATION_MS,
        exhausted_context_policy: str = "replay_context",
        command_latency_ms: int = 0,
        rate_limit_every: Optional[int] = None,
        rate_limit_reads: bool = False,
        retry_after_s: int = 1,
        has_active_device: bool = True,
        clear_queue_on_play: bool = False,
    ) -> None:
        if exhausted_context_policy not in ("replay_context", "stop"):
            raise ValueError(
                "exhausted_context_policy must be 'replay_context' or 'stop' (AN-2)"
            )
        self.track_durations_ms = dict(track_durations_ms or {})
        self.default_duration_ms = default_duration_ms
        self.exhausted_context_policy = exhausted_context_policy
        self.command_latency_ms = command_latency_ms
        self.rate_limit_every = rate_limit_every
        self.rate_limit_reads = rate_limit_reads
        self.retry_after_s = retry_after_s
        self.has_active_device = has_active_device
        # AN-1 negation switch: True = a play override drops the manual queue.
        self.clear_queue_on_play = clear_queue_on_play
        self.fail_next_with_429 = False

        #: Registered context playlists: context_uri -> track ids.
        self.contexts: Dict[str, List[str]] = {}

        # Playback state
        self._context: List[str] = []          # snapshot of the active context
        self._context_uri: Optional[str] = None
        self._context_pos: int = -1
        self._queue: List[str] = []            # the append-only user queue
        self._current: Optional[str] = None
        self._progress_ms: int = 0
        self._is_playing: bool = False

        # Command intake (AN-3)
        self._pending: List[_PendingCommand] = []
        self._swap_next_two = False
        self._command_attempts = 0

        # Forensic record
        self.now_ms: int = 0
        self.played_ids: List[str] = []        # every track that *started*
        self.event_log: List[Dict[str, Any]] = []
        self.max_queue_dup_seen: int = 1 if self._queue else 0
        self.counts: Dict[str, int] = {
            "play": 0, "enqueue": 0, "next": 0, "pause": 0,
            "get_state": 0, "get_queue": 0,
        }

    # -- configuration helpers -------------------------------------------

    def register_context(self, context_uri: str, track_ids: List[str]) -> None:
        """Make a playlist-like context playable via ``play(context_uri=...)``."""
        self.contexts[context_uri] = list(track_ids)

    def duration_of(self, track_id: str) -> int:
        return self.track_durations_ms.get(track_id, self.default_duration_ms)

    def swap_next_two(self) -> None:
        """AN-3: the next two submitted commands take effect in swapped order."""
        self._swap_next_two = True

    # -- inspection -------------------------------------------------------

    @property
    def queue_ids(self) -> List[str]:
        """The manual/appended queue as bare track ids (append-only)."""
        return list(self._queue)

    @property
    def current_id(self) -> Optional[str]:
        return self._current

    @property
    def is_playing(self) -> bool:
        return self._is_playing

    def _log(self, kind: str, **detail: Any) -> None:
        self.event_log.append({"t_ms": self.now_ms, "event": kind, **detail})

    def _note_queue_change(self) -> None:
        if not self._queue:
            return
        worst = max(self._queue.count(tid) for tid in set(self._queue))
        self.max_queue_dup_seen = max(self.max_queue_dup_seen, worst)

    # -- command intake (429s documented; latency/reorder = AN-3) ---------

    def _quota_gate(self, kind: str) -> None:
        """The shared 429 intake — commands always, reads via rate_limit_reads."""
        self._command_attempts += 1
        if self.fail_next_with_429:
            self.fail_next_with_429 = False
            self._log("rate_limited", command=kind)
            raise SimRateLimited(self.retry_after_s)
        if self.rate_limit_every and self._command_attempts % self.rate_limit_every == 0:
            self._log("rate_limited", command=kind)
            raise SimRateLimited(self.retry_after_s)

    def _submit(self, kind: str, **payload: Any) -> None:
        self._quota_gate(kind)
        self.counts[kind] += 1
        cmd = _PendingCommand(self.now_ms + self.command_latency_ms, kind, payload)
        self._pending.append(cmd)
        if self._swap_next_two and len(self._pending) >= 2:
            self._pending[-1], self._pending[-2] = self._pending[-2], self._pending[-1]
            self._swap_next_two = False
            self._log("commands_swapped")
        self._flush_due()

    def _flush_due(self) -> None:
        while self._pending and self._pending[0].due_ms <= self.now_ms:
            cmd = self._pending.pop(0)
            getattr(self, f"_apply_{cmd.kind}")(**cmd.payload)

    # -- the API-shaped command surface -----------------------------------

    def play(
        self,
        *,
        uris: Optional[List[str]] = None,
        context_uri: Optional[str] = None,
        offset: Optional[Dict[str, Any]] = None,
        position_ms: int = 0,
        device_id: Optional[str] = None,
    ) -> None:
        """``PUT /me/player/play`` — uris array OR context_uri, plus offset.

        ``offset`` takes the documented **object form** ``{"position": N}``
        (BASE-05); a bare int is rejected, an out-of-range position is an
        error at application time — no silent clamping.
        """
        if not self.has_active_device and not device_id:
            raise SimNoActiveDevice()                  # AN-7
        if (uris is None) == (context_uri is None):
            raise ProviderError("play needs exactly one of uris / context_uri")
        position = 0
        if offset is not None:
            if not isinstance(offset, dict) or set(offset) != {"position"}:
                raise ProviderError(
                    'offset must use the object form {"position": N} (BASE-05)'
                )
            position = int(offset["position"])
            if position < 0:
                raise ProviderError(f"offset position {position} out of range")
        self._submit(
            "play", uris=uris, context_uri=context_uri,
            offset=position, position_ms=position_ms,
        )

    def add_to_queue(self, uri: str, device_id: Optional[str] = None) -> None:
        """``POST /me/player/queue`` — appends exactly one item, append-only.

        AN-6: the same URI is accepted repeatedly as separate entries (no
        dedup) — load-bearing for the duplication proof, live check LT-11.
        """
        if not self.has_active_device and not device_id:
            raise SimNoActiveDevice()                  # AN-7
        self._submit("enqueue", uri=uri)

    def next(self) -> None:
        """``POST /me/player/next`` issued by *our* app (counts as a command)."""
        if not self.has_active_device:
            raise SimNoActiveDevice()                  # AN-7: all player commands 404
        self._submit("next")

    def pause(self) -> None:
        if not self.has_active_device:
            raise SimNoActiveDevice()                  # AN-7: all player commands 404
        self._submit("pause")

    # User actions inside the Spotify app itself — not Web API commands from
    # us, so they bypass the 429/latency intake and are not counted against us.

    def user_next(self) -> None:
        """The listener presses *next* in their own Spotify app."""
        self._log("user_next", was=self._current)
        self._advance(skipped=True)

    def user_add_to_queue(self, track_id: str) -> None:
        """The listener queues a track in their own Spotify app (UC-17/18)."""
        self._queue.append(track_id)
        self._note_queue_change()
        self._log("user_enqueued", track=track_id)

    # -- command application ----------------------------------------------

    def _apply_play(
        self,
        uris: Optional[List[str]],
        context_uri: Optional[str],
        offset: int,
        position_ms: int,
    ) -> None:
        # AN-1: the context is replaced; whether the manual queue survives is
        # the assumption — default keeps it, clear_queue_on_play negates it.
        if self.clear_queue_on_play and self._queue:
            self._log("queue_cleared_by_play", dropped=list(self._queue))
            self._queue.clear()
        if uris is not None:
            self._context = [_uri_to_id(u) for u in uris]
            self._context_uri = None
        else:
            if context_uri not in self.contexts:
                raise ProviderError(f"unknown context {context_uri}")
            # Snapshot at play time (deliberate simplification, see docstring).
            self._context = list(self.contexts[context_uri])
            self._context_uri = context_uri
        if not self._context:
            raise ProviderError("empty context")
        if not (0 <= offset < len(self._context)):
            raise ProviderError(
                f"offset position {offset} out of range for context of "
                f"{len(self._context)} items"
            )
        self._context_pos = offset
        self._start_track(self._context[self._context_pos], source="play",
                          position_ms=position_ms)

    def _apply_enqueue(self, uri: str) -> None:
        self._queue.append(_uri_to_id(uri))
        self._note_queue_change()
        self._log("enqueued", track=_uri_to_id(uri), queue=list(self._queue))

    def _apply_next(self) -> None:
        self._log("api_next", was=self._current)
        self._advance(skipped=True)

    def _apply_pause(self) -> None:
        self._is_playing = False
        self._log("paused", track=self._current)

    # -- playback mechanics -----------------------------------------------

    def _start_track(self, track_id: str, *, source: str, position_ms: int = 0) -> None:
        self._current = track_id
        self._progress_ms = position_ms
        self._is_playing = True
        self.played_ids.append(track_id)
        self._log("track_started", track=track_id, source=source)

    def _advance(self, *, skipped: bool) -> None:
        """Move to whatever plays next: queue first, then context (AN-5)."""
        if self._current is not None:
            self._log(
                "track_skipped" if skipped else "track_ended",
                track=self._current, progress_ms=self._progress_ms,
            )
        if self._queue:
            self._start_track(self._queue.pop(0), source="queue")
            return
        if self._context and self._context_pos + 1 < len(self._context):
            self._context_pos += 1
            self._start_track(self._context[self._context_pos], source="context")
            return
        # Queue and context both exhausted — AN-2 territory.
        if self.exhausted_context_policy == "replay_context" and self._context:
            self._context_pos = 0
            self._start_track(self._context[0], source="context_replay")
            self._log("context_replayed", context=self._context_uri or "uris")
        else:
            self._current = None
            self._progress_ms = 0
            self._is_playing = False
            self._log("playback_stopped", reason="context_exhausted")

    def tick(self, ms: int) -> None:
        """Advance simulated time; tracks end and pending commands land."""
        remaining = ms
        while remaining > 0:
            step = remaining
            if self._is_playing and self._current is not None:
                left = self.duration_of(self._current) - self._progress_ms
                if left > 0:
                    step = min(step, left)
            if self._pending:
                due_in = max(1, self._pending[0].due_ms - self.now_ms)
                step = min(step, due_in)
            step = max(1, step)

            self.now_ms += step
            remaining -= step
            if self._is_playing and self._current is not None:
                self._progress_ms += step
                if self._progress_ms >= self.duration_of(self._current):
                    self._advance(skipped=False)
            self._flush_due()

    # -- API-shaped views --------------------------------------------------

    def get_playback_state(self) -> Optional[Dict[str, Any]]:
        """``GET /me/player`` — ``None`` models the documented 204 (no device)."""
        if self.rate_limit_reads:
            self._quota_gate("get_state")
        self.counts["get_state"] += 1
        if not self.has_active_device:
            return None
        item = (
            {"id": self._current, "duration_ms": self.duration_of(self._current)}
            if self._current is not None else None
        )
        return {
            "is_playing": self._is_playing,
            "item": item,
            "progress_ms": self._progress_ms,
            "device": {"id": "sim-device", "name": "Simulated Device"},
        }

    def get_queue(self) -> Optional[Dict[str, Any]]:
        """``GET /me/player/queue`` — currently playing plus upcoming (AN-4).

        Without an active device this returns ``None`` — part of AN-7: only
        the 204 for ``GET /me/player`` is documented, the queue-read behaviour
        without a device is an assumption (live check LT-12).
        """
        if self.rate_limit_reads:
            self._quota_gate("get_queue")
        self.counts["get_queue"] += 1
        if not self.has_active_device:
            return None
        upcoming = list(self._queue)
        if self._context and self._context_pos >= 0:
            upcoming += self._context[self._context_pos + 1 :]
        return {
            "currently_playing": (
                {"id": self._current} if self._current is not None else None
            ),
            "queue": [{"id": tid} for tid in upcoming],
        }


# ---------------------------------------------------------------------------
# MusicProvider adapter — app code (runs._apply, watcher) runs unchanged
# ---------------------------------------------------------------------------

class SimulatedSpotifyProvider(MusicProvider):
    """The simulator behind the real provider contract, Spotify-shaped.

    Mirrors the capability profile of :class:`providers.spotify.SpotifyProvider`
    (REMOTE_DEVICE, queue prefetch, queue read) so ``app/runs.py::_apply`` and
    watcher-shaped advance sequences exercise exactly the code paths that talk
    to the live API.
    """

    def __init__(self, player: Optional[SimulatedSpotifyPlayer] = None) -> None:
        self.player = player or SimulatedSpotifyPlayer()
        self.capabilities = ProviderCapabilities(
            id="spotifysim",
            display_name="Simulated Spotify",
            auth=AuthKind.OAUTH2_PKCE,
            playback=PlaybackControl.REMOTE_DEVICE,
            write_batch_size=100,
            read_page_size=50,
            requires_paid_tier=True,
            reports_account_tier=False,
            # ADR-002: the uris window is the execution strategy; the queue is
            # never written any more (only read, forensically).
            supports_context_window=True,
            supports_queue_read=True,
        )

    # -- config / auth --
    def is_configured(self) -> bool:
        return True

    async def begin_auth(self, *, redirect_uri: str, state: str) -> AuthStart:
        return AuthStart(redirect_url=f"https://sim/authorize?state={state}",
                         session_data={"code_verifier": "sim"})

    async def complete_auth(self, *, code, redirect_uri, session_data) -> TokenBundle:
        return TokenBundle(access_token=f"sim-{code}")

    async def identify(self, token: TokenBundle) -> AccountIdentity:
        return AccountIdentity(provider_user_id="sim-user", display_name="Sim User")

    # -- library (minimal; runs are created straight in the DB by the tests) --
    async def list_playlists(self, token: TokenBundle) -> List[PlaylistRef]:
        return [
            PlaylistRef(provider="spotifysim", id=_uri_to_id(uri), name=uri,
                        track_count=len(ids))
            for uri, ids in self.player.contexts.items()
        ]

    async def iter_playlist_tracks(
        self, token: TokenBundle, playlist_id: str
    ) -> AsyncIterator[List[Track]]:
        for uri, ids in self.player.contexts.items():
            if _uri_to_id(uri) == playlist_id:
                yield [
                    Track(provider="spotifysim", id=tid, name=tid,
                          duration_ms=self.player.duration_of(tid))
                    for tid in ids
                ]
                return

    # -- playback --
    async def list_devices(self, token: TokenBundle) -> List[Device]:
        if not self.player.has_active_device:
            return []
        return [Device(id="sim-device", name="Simulated Device",
                       kind="computer", is_active=True)]

    async def play(
        self, token, *, track_ids, offset_position=0, device_id=None, position_ms=0
    ) -> None:
        # ADR-002: the whole uris window in one PUT /play, offset in the
        # documented object form — exactly what providers/spotify.py sends.
        self.player.play(
            uris=[f"spotify:track:{tid}" for tid in track_ids],
            offset={"position": offset_position},
            position_ms=position_ms, device_id=device_id,
        )

    async def skip_next(self, token, *, device_id=None) -> None:
        # POST /me/player/next — the lightweight TS-skip inside the window.
        self.player.next()

    async def enqueue(self, token, *, track_id, device_id=None) -> None:
        # Deprecated (ADR-002): no app code path calls this any more; kept so
        # the simulator can still prove that fact (enqueue count stays 0).
        self.player.add_to_queue(f"spotify:track:{track_id}", device_id=device_id)

    async def pause(self, token, *, device_id=None) -> None:
        self.player.pause()

    async def get_playback_state(self, token: TokenBundle) -> Optional[PlaybackState]:
        data = self.player.get_playback_state()
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
        data = self.player.get_queue()
        if not data:
            return None
        currently = (data.get("currently_playing") or {}).get("id")
        queue_ids = [t["id"] for t in (data.get("queue") or []) if t and t.get("id")]
        return {"currently_playing_id": currently, "queue_ids": queue_ids}
