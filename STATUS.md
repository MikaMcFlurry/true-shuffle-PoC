# STATUS — true-shuffle

**Version 0.2.0 · multi-provider MVP**

This file separates three things that the project's older documents kept
blurring: what is **built**, what is **verified**, and what is **not done**.

---

## Verification legend

| | Meaning |
|---|---|
| **TESTED** | Covered by the automated suite (in-memory connector or stubbed HTTP) |
| **BUILT** | Implemented and reviewed, but no test asserts the real-world behaviour |
| **UNVERIFIED** | Written against the published API; never run against a live account |
| **NOT DONE** | Explicitly out of scope for this version |

`python -m pytest -q` → **201 passed**. `ruff check .` → **clean**.
Reproduced on Python 3.11.15 on 2026-07-30.

---

## Built in this version

### Provider abstraction — TESTED

`MusicProvider` + `ProviderCapabilities` replace the hard-coded Spotify calls.
`core/` no longer contains the string `spotify` anywhere. A service declares how
it works (`REMOTE_DEVICE` / `WEB_PLAYER` / `NONE`, batch sizes, paid tier,
queue prefetch) and the engine and UI adapt from the declaration.

### The three mandatory connectors

| Connector | Auth | Playback | Status |
|---|---|---|---|
| Spotify | OAuth 2.0 PKCE | Spotify Connect remote control | Request paths TESTED, live account UNVERIFIED |
| Apple Music | ES256 developer token + browser-minted Music User Token | MusicKit JS in-page player | Request paths TESTED, live account UNVERIFIED |
| YouTube Music | Google OAuth 2.0 (confidential client) | YouTube IFrame player | Request paths TESTED, live account UNVERIFIED |

The developer-token signing, pagination, batching, quota arithmetic and payload
parsing of all three are tested with stubbed HTTP. **What is not tested is
whether the live services behave as documented** — that needs credentials.

### Auto-advance — TESTED

The gap the previous version had: `/controller/next` existed and nothing else,
so a human had to press a button per track.

- **Spotify:** `app/watcher.py` runs one background task per active run. It
  polls playback, advances on track end, and distinguishes a natural end from a
  skip made inside the Spotify app (which consumes exactly one card). If you
  start playing something outside the deck it reports **drift** and stops
  fighting you for control, leaving the cursor untouched so you can resume.
  Polling is adaptive — it sleeps until just after the current track is due to
  end rather than on a fixed timer.
- **Apple / YouTube:** the in-page player reports `track_ended`, `skip` and
  `playback_failed` to `POST /api/runs/{id}/event`.
- Both paths go through one `asyncio.Lock` per run, so a browser event and the
  watcher cannot burn two cards for one song.

### Correctness and security fixes to the previous version — TESTED

| Was | Now |
|---|---|
| `UNIQUE(user_id, playlist_id, mode, status)` made a *second completed run* of the same playlist impossible | Partial unique index on live runs only; history accumulates freely |
| Tokens stored as plain JSON while comments claimed "encrypted at rest" | AES-256-GCM vault keyed from `SECRET_KEY`; legacy plain rows still readable |
| Any signed-in user could advance or export any run by guessing its integer id | Ownership is part of every query; a foreign run is a 404 |
| OAuth `state` never checked | Generated and verified on every connect flow |
| `_fill_queue` swallowed queue failures silently | Failures are logged as `queue_failed` run events |
| `stop` marked a run `cancelled` while its docstring promised resume | `pause` (resumable) and `cancel` (discards the deck) are now different things |
| Utility Mode blocked the request on large playlists | Background jobs with SSE progress |

### Other — TESTED

- Background job runner with live progress (`/api/jobs/{id}/stream`)
- Run history, skipped-track reporting with reasons, per-run event log
- Export/import, including automatic upgrade of v1 (Spotify-only) run files
- Web UI: connect screen, playlist picker, deck player, run history, both themes

---

## Not verified — the honest list

1. **No live-credential run.** Nothing here has touched a real Spotify, Apple or
   Google account. Every "works" in this repo means "works against the
   documented contract and our fakes".
2. **Apple Music domain registration.** MusicKit requires the serving domain to
   be registered against the MusicKit identifier. Untested.
3. **Spotify queue behaviour in the field.** Whether prefetched queue entries
   survive a hard override, how much latency an override adds, and whether stale
   queue entries bleed through — all still open, exactly as the handoff said.
   The watcher is designed to correct drift, but only a real device shows how
   often it has to.
4. **YouTube quota in practice.** The refusal threshold uses Google's documented
   unit costs. The real budget of a given Cloud project may differ.
5. **Apple library items without a catalog id.** Handled as unplayable-with-a-
   reason; how common they are in a real library is unknown.
6. **Concurrency at scale.** One `asyncio.Lock` per run is correct for a
   single-process PoC and would need rethinking behind more than one worker.

---

## Not done

- No password login — a browser session is the identity (PoC scope)
- No multi-worker deployment story; jobs and watchers are in-process
- Deezer, TIDAL, Amazon Music, SoundCloud are declared in `providers/planned.py`
  with their open questions, not implemented
- The controlled queue-snapshot study (10/50/100/500 playlists, 50 runs) is
  still a separate piece of research and is not part of this codebase

---

## Suggested next steps

1. Create a Spotify app, an Apple MusicKit key and a Google Cloud OAuth client;
   fill in `.env`; walk all three connect flows.
2. Live Mode on Spotify with a real device: measure override latency, queue
   bleed and how reliably native skips are caught.
3. Live Mode on Apple and YouTube in a browser: confirm the end-of-track event
   fires reliably enough to drive the deck.
4. Copy Mode against a genuinely large playlist (1 500+) on Spotify and Apple.
5. Only then update any public status labels on the website.
