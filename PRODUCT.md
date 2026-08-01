# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase: FastAPI + Jinja2 templates, vanilla CSS and ES modules, no
build step and no frontend dependencies. Served locally. This is a hard
constraint — no npm, no framework, no bundler.

## Users

**Primary: the everything-playlist listener.** One person, one enormous
general-purpose playlist (Mika's is ~1,500 tracks), played on shuffle almost
every day. They listen while driving, working, and moving around — not while
staring at a screen. Their frustration is concrete: the same songs keep coming
back, and large parts of the playlist are never heard at all.

They are not building a playlist, curating, or discovering. They already made
the playlist. They want it to actually play through.

**Secondary: the closed-beta tester.** Five Spotify Premium accounts. Same job,
plus a willingness to report what broke.

## Job

1. Connect one or more streaming services.
2. Pick one playlist, whatever its size.
3. Start a run, and then stop looking at the screen.
4. Come back hours or days later and continue on exactly the same track.

The screen is used at the start and the end of a listening session, rarely in
the middle. Any design that assumes sustained attention on the page has
misunderstood the job.

## Mechanism

A run is a **deck of cards**: the playlist is filtered to playable, unique
tracks, dealt once with an unbiased Fisher–Yates shuffle, and stored. Every
card is consumed exactly once — a track that ends and a track the listener
skips both consume one. Nothing repeats until the deck is empty, and the
position survives across sessions and devices.

What makes this different from every "shuffle" button: the order is persistent
and the progress is remembered. It is not a better random number; it is a deck
with a memory.

## Position

true-shuffle never plays audio. The streaming service always does. true-shuffle
decides what comes next and remembers where you are.

## Capabilities

- **Handoff-Modus** — the deck is written into the service as a real playlist;
  the listener plays it in the service's own app. On Spotify and Apple Music,
  progress is reconciled from the service's listening history, so nothing of
  ours stays open.
- **Live-Modus** — true-shuffle drives playback and advances the deck on every
  track end and skip. On Spotify this runs server-side; on Apple Music and
  YouTube Music it runs in the browser tab, because neither service permits
  third-party playback control.
- Resume, run history, export/import of a run, per-run reporting of every
  playlist entry that was left out and why.

## Constraints

- **Three services, three different shapes.** Spotify can be remote-controlled;
  Apple Music and YouTube Music can only be played inside a browser tab.
  YouTube Music additionally has no listening-history API at all. The interface
  must state these differences plainly rather than flatten them.
- **Device parity.** Desktop and phone are equally important; neither is the
  fallback.
- **Interface language is German.** The codebase, comments and documentation
  stay English.
- **Honesty about state.** Nothing has yet been run against live streaming
  credentials. The interface must never imply a service is verified working
  when it is not, and must never report a run as complete when tracks were
  silently dropped.

## Terminology

| Term | Meaning |
|---|---|
| Deck / Lauf | One run: a fixed shuffled order plus a position |
| Karte | One track's slot in that order |
| Handoff-Modus | Deck written as a playlist, played in the service's app |
| Live-Modus | true-shuffle drives playback directly |
| Übersprungen | A playlist entry that never entered the deck (local file, unavailable, duplicate, not a track) |

## Accessibility

Keyboard operation for the transport controls. Contrast must hold in both light
and dark. Motion respects `prefers-reduced-motion`.

## Evidence

A Spotify Extended Streaming History analysis over 100,022 personal track plays
found an 86.7% shuffle share, and track repeats within 8.0% of 50-play windows.
This describes personal listening, **not** any streaming service's playlist
algorithm, and must never be presented as the latter.

## Open decisions

- Legal entity details on the marketing site are unverified and out of scope here.
- Pricing and monetisation: undecided.
