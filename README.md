# true-shuffle

> Plays a playlist like a deck of cards: **every playable, unique track exactly
> once per run**, no repeats until the deck is done, and exact resume across
> sessions — on Spotify, Apple Music and YouTube Music.

Audio always comes from the streaming service itself. true-shuffle decides
*what* plays next; it never becomes the music player.

---

## What works

| | Spotify | Apple Music | YouTube Music |
|---|---|---|---|
| Read playlists | ✅ | ✅ (library) | ✅ (playlists you created) |
| **Copy Mode** — write a shuffled playlist | ✅ | ✅ | ⚠️ quota-limited, see below |
| **Live Mode** — true-shuffle drives playback | ✅ remote-controls your app | ✅ plays in the browser tab | ✅ plays in the browser tab |
| Auto-advance when a track ends | ✅ server-side watcher | ✅ browser events | ✅ browser events |
| Detect a skip made *inside the service's own app* | ✅ | n/a (we own the player) | n/a (we own the player) |
| Exact resume | ✅ | ✅ | ✅ |
| Paid tier required for Live Mode | Premium | subscription | no |

**Verification status:** every path is covered by the automated suite against an
in-memory connector, and the request/response shapes of all three services are
tested with stubbed HTTP. **None of it has been run against real Spotify, Apple
or Google credentials yet** — that is the next step, and no claim here should be
treated as field-proven until it is. See [STATUS.md](STATUS.md).

---

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

cp .env.example .env          # then fill in at least one service
python -c "import secrets; print(secrets.token_urlsafe(48))"   # → SECRET_KEY

python -m uvicorn app.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000>. Services you have not configured are shown as
"needs setup" with the exact environment variables they want — the app runs fine
with only one of the three.

Run the checks:

```bash
python -m pytest -q       # 201 tests
ruff check .
```

---

## The two modes

**Live Mode** — true-shuffle holds the deck and moves it forward on its own.
When a track ends, or you skip, the cursor advances by exactly one card and the
next one starts. Close the tab, come back tomorrow, and you resume on the same
card. This is the actual product.

**Copy Mode** — the shuffled order is written into a new playlist on the
service, and you press play there. No live control needed, so it works anywhere
playlists can be created. The trade-off is that it produces an extra playlist
and cannot track your position.

---

## How each service is wired

The three services differ in one structural way that matters more than any API
detail: **who owns the audio pipeline.**

- **Spotify** exposes a remote-control API, so the server can take over a
  Spotify app you already have open. A background watcher polls playback,
  advances the deck when a track finishes, and — importantly — notices when you
  press *next* inside Spotify itself, so that skip consumes exactly one card
  instead of desynchronising the deck.

- **Apple Music** has no server-side remote control. It has a first-class
  browser player (MusicKit JS), so the page owns playback and reports every
  track end and skip back to the server, which still owns the deck. The ES256
  developer token is minted server-side from your MusicKit `.p8` key; the Music
  User Token is minted in the browser and posted back.

- **YouTube Music** has no public API at all. What exists is the **YouTube Data
  API v3**, where YouTube Music playlists appear as ordinary YouTube playlists.
  This connector uses only official, documented endpoints — no scraping, no
  reverse-engineered internal calls. Playback is the official IFrame player.

### Two YouTube limitations you should know before trying it

1. **Auto-generated playlists are invisible.** "Liked Music", "Your Supermix"
   and friends are not exposed by any public API. Playlists you created are.
2. **Copy Mode is quota-bound.** `playlistItems.insert` costs 50 quota units per
   track against a default budget of 10 000 per day, so copying a 1 500-track
   playlist would need 75 000 units and cannot work. The connector *refuses such
   a write up front* with the arithmetic, instead of dying at track 190. Live
   Mode reads the same playlist for roughly 60 units, so on YouTube the browser
   player is the primary path.

---

## Adding a service

Write one class. Nothing in `core/` or `app/` changes.

```python
class DeezerProvider(MusicProvider):
    capabilities = ProviderCapabilities(
        id="deezer", display_name="Deezer",
        auth=AuthKind.OAUTH2_CODE,
        playback=PlaybackControl.NONE,      # Copy Mode only
        notes=["Playback control is not available to third parties."],
    )
    ...
```

`PlaybackControl` is the important field: `REMOTE_DEVICE` (the server drives an
app you already have open), `WEB_PLAYER` (the browser owns audio and reports
events), or `NONE` (Copy Mode only). The run engine and the UI adapt from that
declaration alone — no provider names are special-cased anywhere.

Register it in `providers/registry.py`. Services that are *candidates* rather
than connectors live in `providers/planned.py`, where each one records what
still has to be checked before it is written — visible in the UI as "planned",
never as working.

---

## Layout

```
core/          Pure domain logic, zero I/O and zero provider knowledge
  models.py      Track, RunState, capabilities, enums
  shuffle.py     Fisher–Yates, filtering, dedup, similarity guard
  engine.py      The deck state machine: start / advance / previous / reconcile
  exporter.py    Portable run files (v1 imports still work)

providers/     One class per streaming service
  base.py        The MusicProvider contract + capability declaration
  spotify.py     Web API + Spotify Connect remote control
  apple.py       Apple Music API + MusicKit JS web player
  youtube.py     YouTube Data API v3 + IFrame player
  planned.py     Declared-but-not-implemented candidates
  http.py        Shared retries, rate limits, per-account serialisation

app/           FastAPI: HTTP, persistence, background work
  watcher.py     Polls remote playback → auto-advance, native-skip detection
  runs.py        The only place a cursor is allowed to move
  jobs.py        Background reads/writes with SSE progress
  crypto.py      AES-256-GCM token vault
  db.py          SQLite schema v2 (multi-provider) + migration from v1
```

---

## Security posture, stated plainly

- OAuth tokens are encrypted at rest with AES-256-GCM, keyed from `SECRET_KEY`.
  This protects a stolen `.db` file. It does **not** protect against someone who
  also has your `SECRET_KEY`.
- Every run and job query is scoped by owner, so one browser session cannot read,
  advance or export another's run.
- The OAuth `state` parameter is generated and verified on every connect flow.
- The app warns at startup and on the home page if `SECRET_KEY` is still the
  default.
- This is a local proof of concept. It has no password login — a browser session
  *is* the identity. Do not expose it to the internet as-is.

---

## Documents

- [STATUS.md](STATUS.md) — what is built, what is verified, what is not
- [HANDOFF.md](HANDOFF.md) — architecture decisions and open questions
- [SPEC_TRUE_SHUFFLE_POC.md](SPEC_TRUE_SHUFFLE_POC.md) — the original
  Spotify-only spec, kept for history and now partly superseded
