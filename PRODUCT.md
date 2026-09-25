# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated (confirmed 2026-09-25): Vite + Preact + TypeScript client, served
as static assets by a Cloudflare Worker (Workers Static Assets). Backend is
the same Worker plus one Durable Object per listener. No heavy frameworks.
Interface language German; code, comments and docs English.

## Users

**Primary: the owner (Mika) and up to four friends** — Spotify Premium
listeners with many playlists: genre playlists and big mixed ones, anything
up to ~10 000 songs. Spotify's Development Mode caps the app at five
accounts in total; there is no public audience.

Situation: in the car, at work, on the move. They glance at the phone, tap a
station, and put the phone away. They come back only to change something or
to see how far they are. Sessions with the screen are seconds long; listening
sessions are hours long, spread over days and weeks.

Job, in the owner's words: *"Start drücken und Musik hören, die mir gefällt,
ohne schnelle Wiederholungen, mit Neuem dazwischen."*

## Product Purpose

Spotify's own shuffle repeats songs quickly, replays nearly the same queue
after a reshuffle days later (sometimes in reverse after a car stop), loses
progress, and leaves large parts of big playlists unheard. True Shuffle
replaces that with stations that have a memory:

1. progress is never lost, whatever happens in Spotify in between;
2. no quick repeats — a heard song is locked for a while;
3. every song of a station comes eventually, long-unheard and never-heard
   songs first;
4. favourites come more often, but at most once a week;
5. new music the listener does not know yet is mixed in.

Success: the owner presses start and stops thinking about shuffle.

## Positioning

One memory per song across all stations and all listening — including
music heard outside True Shuffle — that is never lost. Spotify's shuffle has
no memory; True Shuffle is nothing but memory plus a planner.

## Operating Context

- Spotify always plays the audio. Each station is a private Spotify playlist
  "True Shuffle · <Sender>" that True Shuffle rewrites from memory whenever
  nobody is listening to it; it works on any device (phone, car/CarPlay,
  speakers), even when started directly in Spotify.
- True Shuffle reads what was heard from Spotify every few minutes in the
  background. Nothing of True Shuffle needs to stay open.
- A "Sender" (station) has one or more playlists (and/or "Lieblingssongs")
  as sources. Every chosen playlist becomes a station; "Alles" combines all.
- One slider per station, "Entdecken ↔ Vertraut"; default preset
  "Entdecker" (≈ 60 % unheard, 10 % favourites, 30 % discoveries). Advanced
  rules (favourite cooldown, favourite share, skip behaviour, discovery on/off,
  artist spacing) sit behind "Erweitert".
- Guest mode ("Gast-Modus"): while on, nothing heard counts; switches itself
  off after a set time or manually.

## Capabilities and Constraints

- Sign in with Spotify; phone and desktop see the same stations.
- Taste signals: Spotify hearts, listening behaviour (early skips < 30 s make
  a song rarer; three make it rare), thumbs up/down in the app, optional
  import of the Spotify extended streaming history.
- Discoveries: more from liked artists, their new releases, Last.fm,
  Deezer, genre search, AI suggestions (Claude Sonnet 5 with key, Workers AI
  otherwise). Every suggestion is verified on Spotify. Liked discoveries go
  into "True Shuffle · Entdeckungen" and join the station.
- Premium only. Starting playback without Premium is refused with an
  explanation. Spotify's Autoplay and Smart Shuffle cannot be switched off
  through the API; the app says so when they interfere.
- Never interferes when the listener plays something else in Spotify.
- Free Cloudflare plan: work is split into small resumable steps.
- Terminology (UI): Sender, Runde, Entdecken ↔ Vertraut, Neuentdeckung,
  Favorit, Gast-Modus, Lieblingssongs.

## Brand Commitments

Name: **True Shuffle**. German interface. The previous visual world
("Plattenschrank" record-crate) was explicitly discarded by the owner and is
an anti-reference, not a starting point.

## Evidence on Hand

- A personal analysis of 100 022 Spotify plays found an 86.7 % shuffle share
  and track repeats within 8.0 % of 50-play windows. It describes personal
  listening, not Spotify's algorithm, and must never be presented as the
  latter.
- No testimonials, users, press or metrics exist. Do not invent any.

## Product Principles

1. **Glance, tap, gone.** The screen serves seconds; the music serves hours.
2. **Memory is the product.** Progress and history are always visible and
   never silently lost or reset.
3. **Say what Spotify does.** When Spotify's own behaviour (Autoplay, Smart
   Shuffle, missing Premium, no device) gets in the way, say it plainly.
4. **Never fight the listener.** Their own Spotify use is sacred.
5. **Honest numbers.** Counts, rounds and progress are real, never rounded up.

## Accessibility & Inclusion

Phone first, desktop fully equal. Usable at a glance and one-handed; large
touch targets (usable in a parked car). Keyboard operable; contrast holds in
light and dark; respects reduced motion.
