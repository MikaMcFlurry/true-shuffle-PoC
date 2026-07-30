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
| Read playlists | ✅ (playlists you own or collaborate on) | ✅ (library) | ✅ (playlists you created) |
| **Handoff Mode** — deck written as a playlist, you play it in the app | ✅ | ✅ | ⚠️ quota-limited, see below |
| ↳ progress tracked with **nothing of ours open** | ✅ history sync | ✅ history sync | ❌ no history API exists |
| **Live Mode** — true-shuffle drives playback | ✅ remote-controls your app | ✅ plays in the browser tab | ✅ plays in the browser tab |
| ↳ needs our page open | ❌ runs on the server | ✅ tab must stay open | ✅ tab must stay open |
| Auto-advance when a track ends | ✅ server-side watcher | ✅ browser events | ✅ browser events |
| Detect a skip made *inside the service's own app* | ✅ | n/a (we own the player) | n/a (we own the player) |
| Exact resume | ✅ | ✅ | ✅ |
| Paid tier required for Live Mode | Premium | subscription | no |

> **Setting Spotify up is a separate gate from using it.** Spotify requires the
> *owner of the developer app* to have Premium for an app in development mode to
> function at all, and every other account must be allowlisted in the dashboard
> (max 5 users). A free-account listener can use Handoff Mode, but only through
> an app whose owner pays. Since July 2026 the development-mode quota is counted
> per developer account rather than per Client ID, so apps you own share one
> budget and exhausting it answers HTTP 429 with `reason: QUOTA_EXCEEDED`; the
> Client ID limit went the other way, from 1 to 25. Checked against Spotify's
> own docs in July 2026; re-check before relying on it.

> **Spotify's February 2026 cut is why the table above gained a qualifier.** A
> Development Mode client created after 11 February 2026 gets a reduced endpoint
> set with no grace period: playlist contents only for playlists the listener
> owns or collaborates on, no batch reads at all, and no `country`/`product` on
> `GET /me` — so the app cannot know a listener lacks Premium until playback is
> refused. See `providers/spotify.py` for what each of those cost and how it is
> paid.

### Does anything have to stay open?

No — on Spotify and Apple Music, and that is a design goal rather than a
side effect.

- **Spotify** never needs it. The watcher runs on the server and drives the
  Spotify app you already have open, so you can close the browser entirely.
- **Apple Music** has no server-side remote control, so *Live Mode* genuinely
  requires the tab. **Handoff Mode** does not: the deck is written into your
  library, you play it in the Apple Music app, and the server reconciles your
  position from `GET /v1/me/recent/played/tracks`. Same promise — every track
  once, exact resume — with nothing of ours running.
- **YouTube Music** is the one real gap. YouTube removed watch history from the
  Data API years ago and never replaced it, so a deck played in the YouTube app
  cannot report back. Live Mode in the tab is the only mode there that tracks
  your position, and the UI says so instead of implying otherwise.

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

Open <http://127.0.0.1:8000>. The interface is German; the codebase is English.
Services you have not configured are shown as
"needs setup" with the exact environment variables they want — the app runs fine
with only one of the three.

Run the checks:

```bash
python -m pytest -q       # all green, no failures
ruff check .
```

---

## The two modes

**Handoff Mode** — the shuffled order is written into a real playlist on the
service, and you play it there: phone, car, speaker, whatever you normally use.
Where the service exposes a listening history, true-shuffle reads back how far
you got, so the deck still keeps your place and still finishes exactly once.
Nothing of ours runs while you listen.

**Live Mode** — true-shuffle holds the deck and moves it forward the moment a
track ends or you skip. On Spotify this happens on the server, and a skip you
make *inside Spotify* consumes exactly one card like any other. On Apple Music
and YouTube it happens in the browser tab, because neither service lets anything
else control playback.

Both modes resume on exactly the card you stopped on. The difference is who is
holding the remote.

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

### Is this YouTube, or YouTube Music?

Both, and the distinction matters enough to be precise about.

**There is no public YouTube Music API.** The connector uses the YouTube Data
API v3, which is the only official route. Playlists you created *inside YouTube
Music* are reachable through it, because they are YouTube playlists on the same
Google account — so for the everything-playlist this product exists for, it
works.

| | Reachable |
|---|---|
| Playlists you created (in YouTube **or** YouTube Music) | ✅ |
| Your YouTube Music **library** (songs/albums added, not in a playlist) | ❌ |
| **Liked Music** (the `LM` playlist) | ❌ |
| **Uploads** (your own files in YouTube Music) | ❌ |
| Auto-generated mixes (Supermix, Discover Mix) | ❌ |
| Playback | the YouTube player, not the YouTube Music player |

Nothing public exposes the ❌ rows.

There is an **opt-in second connector** that does reach them —
`providers/ytmusic_unofficial.py`, built on `ytmusicapi`, which drives
YouTube's *internal* API. It adds the library, Liked Music, uploads and
listening history, and that last one also makes Handoff Mode work on YouTube
with nothing of ours open. The trade is real and stated where it cannot be
missed: it can break at any time without notice, and using it is very likely
against YouTube's terms of service.

It is off unless you switch it on deliberately — **both** of these, either alone
does nothing:

```bash
pip install -r requirements-optional.txt
ENABLE_UNOFFICIAL_YTMUSIC=true          # in .env
```

Then run `ytmusicapi browser` and paste the resulting `browser.json` into the
connect page. The official connector stays the default path to YouTube Music.

Because a YouTube playlist can hold anything, every entry is checked against
YouTube's own **Music category (10)**, with an exemption for `<Artist> - Topic`
channels, which are YouTube Music's own catalogue uploads. A podcast episode
sitting in a playlist is reported as `not_music` rather than dealt into a music
deck. `videos.list` costs one quota unit whatever parts you request, so this
check is free.

### Two more YouTube limits

1. **No listening history.** YouTube removed watch history from the Data API and
   never replaced it, so a YouTube deck can only be tracked in Live Mode, with
   the tab open. Spotify and Apple Music have no such gap.
2. **Handoff Mode is quota-bound.** `playlistItems.insert` costs 50 quota units per
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

Two capability fields carry most of the weight. `PlaybackControl` says who owns
the audio pipeline: `REMOTE_DEVICE` (the server drives an app you already have
open), `WEB_PLAYER` (the browser owns audio and reports events), or `NONE`
(Handoff only). `supports_history_sync` says whether a deck can be tracked with
nothing of ours open. The run engine, the watcher and the UI adapt from those
declarations alone — no provider names are special-cased anywhere.

Register it in `providers/registry.py`. Services that are *candidates* rather
than connectors live in `providers/planned.py`, where each one records what
still has to be checked before it is written — visible in the UI as "planned",
never as working.

---

## Layout

```
PRODUCT.md     Product truth (users, job, mechanism, constraints)
DESIGN.md      The built visual world, recorded after the build

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
  demo.py        In-memory service for testing without credentials (opt-in)
  planned.py     Declared-but-not-implemented candidates
  http.py        Shared retries, rate limits, per-account serialisation

app/           FastAPI: HTTP, persistence, background work
  static/        One stylesheet, two ES modules, two self-hosted OFL fonts
  watcher.py     Two loops: poll remote playback (Live) and poll listening
                 history (Handoff, no tab needed)
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
  *is* the identity. Do not expose it to the internet as-is. If you do deploy it
  for testers, set `ACCESS_CODE`: one shared code, asked once per browser,
  compared in constant time. It keeps strangers out of a beta and is not a user
  system. See [DEPLOY.md](DEPLOY.md).

---

## Documents

- [TESTEN.md](TESTEN.md) — Schritt-für-Schritt-Anleitung zum Testen aller
  Funktionen; Teil A braucht kein einziges Konto
- [DEPLOY.md](DEPLOY.md) — die App online stellen (Fly.io), mit der Begründung,
  warum eine serverlose Plattform hier nicht funktioniert
- [HANDOFF_BROWSER_SETUP.md](HANDOFF_BROWSER_SETUP.md) — fertiger Auftragstext
  für einen Assistenten mit Browser-Zugriff, der Fly und Spotify einrichtet
- [STATUS.md](STATUS.md) — what is built, what is verified, what is not
- [DESIGN.md](DESIGN.md) — the interface's thesis and the rules that hold it up
- [HANDOFF.md](HANDOFF.md) — architecture decisions and open questions
- [SPEC_TRUE_SHUFFLE_POC.md](SPEC_TRUE_SHUFFLE_POC.md) — the original
  Spotify-only spec, kept for history and now partly superseded
