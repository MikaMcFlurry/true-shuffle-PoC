# True-Shuffle PoC — Product Specification

> **Version**: 0.1-draft · **Date**: 2026-02-22
>
> ---
>
> ⚠️ **HISTORICAL — partly superseded as of 2026-07-30 (v0.2.0).**
>
> This document describes the original **Spotify-only** proof of concept. The
> product rules it states (deck-of-cards run, Fisher–Yates, dedup, exact resume,
> the skip semantics) are still correct and still implemented. Everything it
> says about *architecture* is not:
>
> * true-shuffle is now multi-provider — Spotify, Apple Music and YouTube Music
>   behind a `MusicProvider` abstraction, not direct Spotify calls;
> * "Controller Mode" advances **automatically** on track end and native skip,
>   rather than only via a manual `next` call;
> * the database schema, routes and module layout have all changed.
>
> Read [README.md](README.md) for how the system works today, [STATUS.md](STATUS.md)
> for what is verified, and [HANDOFF.md](HANDOFF.md) for the architecture
> decisions. This file is kept for provenance.

---

## 1  Product Goal

Provide a **deterministic, unbiased shuffle** for Spotify playlists that the
native Spotify shuffle cannot guarantee.  Two modes cover different use-cases.

---

## 2  Modes

### 2.1  Utility Mode (all accounts)

| Step | Detail |
|------|--------|
| **Read** | Fetch all tracks of a playlist (paginated, Spotify max 100/page) |
| **Dedup** | Each track URI appears **max 1×** per run |
| **Shuffle** | Unbiased Fisher–Yates |
| **Write** | Create a **new** Spotify playlist with the shuffled order (batch writes of 100) |
| **Play** | User plays the new playlist **linearly** in Spotify |

### 2.2  Controller Mode (Premium-only)

| Step | Detail |
|------|--------|
| **Queue Buffer** | Pre-queue the **next 5 tracks** via `POST /me/player/queue` |
| **Hard Override** | Immediately call `PUT /me/player/play` with the correct track so no random/foreign track is audible |
| **Advance** | On "Next" or detected skip → mark current as played, advance cursor, refill buffer |
| **Resume** | Continue from saved `(user, playlist, mode)` cursor |

---

## 3  Controller Queue-Buffer Strategy

```
Buffer size  = 5  (configurable via env QUEUE_BUFFER_SIZE)
Refill       = after each advance (top-up to 5)
Playback     = hard-override first, then queue fills behind

Sequence on "Next":
  1. cursor += 1
  2. PUT /play  { uris: [tracks[cursor]] }      ← instant override
  3. for i in 1..buffer_size:
       POST /queue  { uri: tracks[cursor + i] }  ← background fill
  4. persist cursor to DB
```

> **All Spotify Player API calls are strictly sequential** (mutex/lock).
> No parallel requests to avoid 429 and race conditions.

---

## 4  Hard-Override Rule

- Before any queued track can start, `PUT /me/player/play` fires with the
  exact target track.
- This guarantees **zero audible bleed** from Spotify's own queue or autoplay.

---

## 5  Product Rules

| Rule | Detail |
|------|--------|
| **Dedup** | Each track max 1× per run |
| **Skip unavailable** | Local files, episodes, unavailable tracks → skipped, **not** marked played, reported separately |
| **Resume** | One active run per `(user_id, playlist_id, mode)` — same order + cursor |
| **New order** | Only on: run completed, or explicit "Shuffle refresh" click |
| **Similarity guard** | After refresh: retry shuffle up to 5× if first-N similarity > threshold (configurable) |

---

## 6  Persistence & Resume

- **Database**: local **SQLite** (`DB_PATH` from `.env`)
- **Tables** (planned):
  - `users` — spotify_user_id, display_name, token blob (encrypted at rest)
  - `runs`  — id, user_id, playlist_id, mode, shuffled_order (JSON), cursor, status, created_at, updated_at
- On app restart the run resumes from the last persisted cursor.

---

## 7  Export / Import

- Export = JSON snapshot of a run (order, cursor, metadata).
- **OAuth tokens are NEVER included** in export.
- Import restores order + cursor for a different developer instance.

---

## 8  Security & Token Handling

- Tokens stored in SQLite, **never** in git, **never** in exports.
- `.env` excluded via `.gitignore`.
- PKCE flow (no client secret needed for public apps).

---

## 9  UI Branding Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-primary` | `#1DB954` | Spotify Green — primary actions, active states |
| `--color-primary-dark` | `#1AA34A` | Hover / pressed variant |
| `--color-bg` | `#121212` | Page background (dark mode) |
| `--color-surface` | `#181818` | Cards, panels |
| `--color-surface-light` | `#282828` | Elevated surfaces, hover rows |
| `--color-text` | `#FFFFFF` | Primary text |
| `--color-text-muted` | `#B3B3B3` | Secondary / helper text |
| `--color-accent` | `#1ED760` | Success, highlights |
| `--color-error` | `#E22134` | Errors, destructive actions |
| `--color-warning` | `#F59B23` | Warnings |

---

## 10  Tech Stack (PoC)

| Layer | Choice |
|-------|--------|
| Backend | Python 3.11+, FastAPI, Uvicorn |
| HTTP client | httpx (async) |
| Database | SQLite (aiosqlite) |
| Auth | Spotify PKCE via browser redirect |
| Linter | Ruff |
| Tests | pytest |
| Config | python-dotenv + `.env` |

---

*This spec will be refined as tickets are implemented.*
