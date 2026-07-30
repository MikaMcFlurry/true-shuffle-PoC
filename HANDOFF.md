# HANDOFF — true-shuffle

**Updated 2026-07-30 (v0.3.0) · supersedes the February 2026 handoff entirely.**

> The previous version of this file described a codebase that could not start
> (`itsdangerous` missing, Python 3.9 type-hint crashes, export/import absent).
> All of that was already fixed by later commits, and the file was never
> updated — which is exactly the failure mode this document now tries to avoid.
> Treat [STATUS.md](STATUS.md) as the source of truth for *what is verified*,
> and this file for *why the architecture looks the way it does*.

---

## The one decision everything else follows from

Streaming services differ in an API-detail way that does not matter much, and in
one structural way that matters enormously: **who owns the audio pipeline.**

| | Who plays the audio | What that means for us |
|---|---|---|
| `REMOTE_DEVICE` | The service's own app, which we can command | We poll playback and push the next track. We can also be *interrupted* by the user acting in that app. |
| `WEB_PLAYER` | A browser SDK running in our page | We command it directly, and it tells us when a track ends. We cannot touch playback happening in the service's real app. |
| `NONE` | The user, manually | Copy Mode only. |

Spotify is `REMOTE_DEVICE`. Apple Music and YouTube Music are `WEB_PLAYER`.
Everything else — whether Live Mode is offered, whether a queue is prefetched,
whether a background watcher runs, what the player page renders — is derived
from this one enum. No code branches on a provider *name*.

This is why the abstraction is `PlaybackControl` and not, say, a list of
supported methods: getting this wrong would mean either pretending Apple can be
remote-controlled (it cannot) or giving up on Live Mode for Apple entirely
(unnecessary — the browser player is a perfectly good pipeline).

---

## The deck rules, and where they live

`core/engine.py` is a pure state machine. It never does I/O, so the product
rules are testable without a network:

- A track is consumed **exactly once** per run. A user skip consumes a card;
  so does a track playing to the end. This is the handoff's §2.2 distinction,
  and it is the difference between "no repeats" being true and being a slogan.
- An **unplayable entry** (local file, unavailable, episode, duplicate) never
  enters the deck at all, and is recorded with its reason. This is what makes
  the honest claim possible: *every playable, unique track*, not "0 skipped".
- The cursor only moves forward, and only through `app/runs.py`. One
  `asyncio.Lock` per run guarantees that the watcher and a browser event
  reporting the same track end cannot burn two cards.
- Resume re-asserts the stored cursor rather than restarting the deck.

`core/engine.reconcile()` is the interesting one: it reads a polled playback
snapshot and decides whether the deck ended a track, was skipped natively, or
**drifted** (the listener is playing something we did not deal). Drift is
deliberately not an advance — we stop driving and keep the cursor, because
fighting the user for control of their own player is worse than pausing.

---

## Decisions taken, with reasons

**The interface is a hi-fi chassis, and the accent is amber.**
The product's own pitch is "like the good old MP3 player, but with your
streaming service", so the UI is built like a piece of hi-fi: graphite chassis,
warm backlit-panel text, and one amber indicator colour borrowed from a VU
meter. The deck position is a tape counter, not a percentage bar.

Amber is also the practical choice: Spotify green, Apple red and YouTube red all
sit on this screen at once, and the chrome must not look like any of them. Each
service appears only as a 3px edge on its own card. All of it lives in
`app/static/style.css` as tokens, so a different palette is one file.

**A browser session is the identity.**
No password login. Streaming accounts attach to an opaque random session handle.
Right for a local PoC; the wrong shape for anything public, and `app/deps.py`
says so.

**Encryption at rest is real now, and its limits are stated.**
AES-256-GCM keyed from `SECRET_KEY` via scrypt. It defeats a stolen database
file. It does not defeat someone who also has the key, and `app/crypto.py` says
that rather than implying more.

**YouTube Copy Mode refuses impossible writes.**
`playlistItems.insert` costs 50 quota units against a 10 000/day default. A
1 500-track copy needs 75 000 and cannot succeed. Rather than discovering this
at track 190, the connector does the arithmetic first and explains it. This is
also why YouTube's `write_batch_size` is 1 — there is no batch endpoint, and
declaring otherwise would silently drop tracks.

**Handoff Mode tracks progress instead of just writing a playlist.**
Writing a shuffled copy and calling the run "completed" was a cop-out: the
listener got no-repeats but lost resume, which is half the product. Spotify and
Apple Music both expose a recently-played endpoint, so the run now stays active
and a slow watcher reconciles the cursor against it. That is what makes "nothing
has to stay open" true rather than aspirational — and on a Spotify free account
it is the only tracking available at all, since playback control needs Premium.

`reconcile_history()` is conservative on purpose: a bounded look-ahead window,
land past the furthest matched card, never move backwards. The failure mode it
guards against is a listener playing one deck track from an album and having the
cursor jump hundreds of cards.

**Planned connectors are data, not stubs.**
`providers/planned.py` lists Deezer, TIDAL, Amazon Music and SoundCloud with the
questions that must be answered before writing them. They appear in the UI as
"planned" with those questions visible. The master handoff is explicit that a
February 2026 policy read is not evidence about today, so nothing here states a
conclusion about their current terms.

---

## Where the real risk still is

Everything in this repo is tested against fakes. The behaviours that will
decide whether the product works are all on the other side of a real account:

1. **Spotify override latency and queue bleed.** We prefetch 5 tracks and hard-
   override on advance. Whether an override leaves stale queue entries that
   later bleed through is unmeasured. The watcher will correct it; how audible
   the correction is, nobody knows yet.
2. **Native-skip detection accuracy.** `reconcile()` distinguishes a skip from a
   clean end using progress thresholds (`NEAR_END_MS`, `SKIP_PROGRESS_MS`).
   Those numbers are reasoned, not measured. They are constants at the top of
   `core/engine.py` precisely so they can be tuned against real data.
3. **Apple MusicKit in practice.** Domain registration, whether a stored Music
   User Token survives long enough to be worth storing, and how many library
   items lack a catalog id.
4. **History-sync accuracy.** The look-ahead window and the 60-second poll are
   reasoned, not measured. Two things need real data: how quickly each service
   surfaces a play, and how often a listener plays a deck track from somewhere
   else and nudges the cursor early.
5. **Whether Live Mode's open tab matters at all** now that Handoff Mode is
   tracked. On Apple Music the tab-free path may simply be the better product,
   with Live Mode reserved for people at a desk.

---

## Open questions for Mika

1. Is the amber-on-graphite hi-fi direction right? It is a deliberate move away
   from generic dark-app styling and toward the "good old MP3 player" line in
   the site's own copy. Tokens are in one file if not.
2. YouTube is the only service where a deck cannot be tracked without an open
   tab, because no public history API exists. Ship it Live-Mode-only, or hold
   YouTube back until that reads better?
3. YouTube also cannot see auto-generated playlists ("Liked Music", mixes). Is
   user-created-playlists-only enough to be worth shipping?
4. The website still shows service badges that this codebase cannot yet back up
   with a live-credential run. Recommendation unchanged: change nothing publicly
   until STATUS.md's next steps are done.

---

## What was deliberately not touched

The `true-shuffle-site` repository. The task was the MVP; changing public
marketing claims — especially service status labels — before any live-credential
verification would repeat the exact mistake the master handoff warns about.
The site's known issues (the `true-shuffel` spelling in `README.md`, the
`signup_success` event firing for review and contact submissions, `CLAUDE.md`
describing an impressions slider that `main` no longer has) are real and worth
fixing, but as their own piece of work.
