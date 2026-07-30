# STATUS — true-shuffle

**Version 0.3.0 · multi-provider MVP, tab-free decks**

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

`python -m pytest -q` → **305 passed**. `ruff check .` → **clean**.
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
| Spotify | OAuth 2.0 PKCE | Spotify Connect remote control | Request paths TESTED against the **February 2026** API, live account UNVERIFIED |
| Apple Music | ES256 developer token + browser-minted Music User Token | MusicKit JS in-page player | Request paths TESTED, live account UNVERIFIED |
| YouTube Music | Google OAuth 2.0 (confidential client) | YouTube IFrame player | Request paths TESTED, live account UNVERIFIED |
| YouTube Music (unofficial, opt-in) | pasted browser credential | YouTube IFrame player | Mapping TESTED against a fake client, live account UNVERIFIED |

The unofficial connector is **off by default** and needs both
`ENABLE_UNOFFICIAL_YTMUSIC=true` and an installed `ytmusicapi`; the full suite
passes with the package absent, so the dependency really is optional. It is the
only path to the YouTube Music library, Liked Music, uploads and history — and
the only connector here that is not built on a published contract.

The developer-token signing, pagination, batching, quota arithmetic and payload
parsing of all three are tested with stubbed HTTP — for Spotify, against the
post-February-2026 shapes: batch track reads no longer exist there,
`/playlists/{id}/items` caps at 50 per page, and the playlist payload renamed
`tracks` → `items` and `track` → `item`. **What is not tested is whether the
live services behave as documented** — that needs credentials.

### Tab-free decks (Handoff Mode) — TESTED

Answering "nothing should have to stay open":

* **Spotify** never needed a tab — the watcher is server-side.
* **Apple Music** now doesn't either. `GET /v1/me/recent/played/tracks` is
  polled and the deck is reconciled against it, so you play the shuffled
  playlist in the Apple Music app and true-shuffle still knows where you are.
* **YouTube Music** is the honest exception: YouTube removed watch history from
  the Data API and never replaced it, so `supports_history_sync` is False and
  the UI says a YouTube deck played outside Live Mode is not tracked.

`core.engine.reconcile_history()` is deliberately conservative: only a window
ahead of the cursor is considered (so a song played from an album cannot yank
the deck to the end), the cursor lands past the furthest matched card, and it
never moves backwards.

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
- Web UI rebuilt as **Der Plattenschrank** (see HANDOFF.md): German interface,
  the deck rendered as a crate of spines with the divider at the cursor, dark
  and light both designed, desktop and mobile at parity, keyboard transport,
  skeleton loading and real empty states
- `npx impeccable detect app/` reports zero anti-patterns; the earlier build
  tripped four, including the AI-tell card edge stripe

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
4b. **History-sync latency and false positives.** The reconciliation window and
   the 60-second poll are reasoned, not measured. A listener who plays a deck
   track from somewhere else within the window could nudge the cursor early;
   how often that happens in practice is unknown.
5. **Apple library items without a catalog id.** Handled as unplayable-with-a-
   reason; how common they are in a real library is unknown.
6. **Concurrency at scale.** One `asyncio.Lock` per run is correct for a
   single-process PoC and would need rethinking behind more than one worker.
7. **Spotify's February/July 2026 API against a live account.** The connector
   was migrated to the reduced endpoint set — `/playlists/{id}/items`,
   `POST /me/playlists`, per-id `GET /tracks/{id}`, no `country`/`product` on
   `/me` — and the stubs now encode those shapes. What no test can settle:
   whether `is_playable` really is populated from the token's implicit market
   now that `available_markets` is gone; whether a non-owned playlist answers
   403 or an empty page (both are handled, only one happens); whether a
   1 500-track deck's ≈30 reads and ≈15 writes trip the per-developer-account
   quota; and what a real free account returns when Live Mode is refused, since
   Spotify documents the Premium requirement but not the failure body.

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
4. Handoff Mode against a genuinely large playlist (1 500+) on Spotify and
   Apple, including how quickly history sync notices progress.
5. Only then update any public status labels on the website.
