# Listening samples in the Verlauf

Baseline: release 1.1.0, `17374f7534354531608871fc9f832f408bc0d058` (tree
`0e165b94a96fee8b88a0d7d030e6e63583068fa8`). Branch
`feat/history-deezer-preview-261017`. Local only: not deployed, not published.

Every Verlauf row gets a key „Hörprobe“: a tap plays Deezer's short public
sample of that recording on the page. Spotify is neither asked nor told
anything: no play, pause, seek, next, transfer, queue, shuffle or volume
command, no Spotify embed or SDK, no Spotify fallback. Nothing stored changes:
Verlauf, import, ratings, memory, skip counts, weighting, queue. No migration,
binding, auth or scope change. The older fallback client
(`src/client-fallback-8d`) is untouched.

## Source (checked 2026-10-17/18)

- Deezer's public API, no account, no app id, no token: the existing
  `DEEZER_API_BASE` (`https://api.deezer.com`), already used keyless for
  discovery. `GET /search?q=<artist> <title>&limit=25` answered with
  `data[]` of tracks carrying `id, readable, title, title_short,
  title_version, isrc, link, duration, preview, artist.name, album.title`.
  The advanced syntax (`artist:"…" track:"…"`) answered `total: 0` for the
  same song that day, so it is not used.
- `preview` is a signed HTTPS address on `https://cdnt-preview.dzcdn.net`
  (`?hdnea=exp=<unix seconds>~acl=…~hmac=…`); in the probe it ran out about
  15 minutes after it was issued. A `HEAD` on it: 200, `audio/mpeg`, no
  redirect, about 30 s at 128 kbit/s. The address is used exactly as sent,
  only from that host, never built or guessed, never cached, never relayed:
  the Worker returns metadata only and never touches audio.
- The API reference pages (`developers.deezer.com/api/...`) redirected to a
  login on 2026-10-17 and could not be read. The terms of use
  (`developers.deezer.com/termsofuse`) were readable: free access, strictly
  non-commercial, content limited to strictly private use within a family
  scope, and only 30-second samples without Deezer Premium+. Users must be
  told the conditions of use. **This is no legal clearance.** Whether
  true-shuffle's private use fits these terms is the owner's decision. The
  page says „Kurze Hörprobe von Deezer (höchstens 30 Sekunden) … Nur zum
  privaten Anhören“, names Deezer in text and links back to the recording's
  Deezer page.
- Correction 2026-10-18: `developers.deezer.com/guidelines/logo` is readable
  and says every application using the Deezer API „must have to include a
  clearly visible Deezer Logo“ (mandatory). The earlier note that the
  trademark guidelines sat behind the login no longer holds. The page shows
  **no logo yet**: an open gate before any release, together with the
  owner's decision on the terms of use.
- Raw probe answers (tokens redacted) are in the delivery's evidence.

## Which recording

The Verlauf's own title, artists, album and length (no ISRC is stored). One
search per tap. A Deezer track counts only when all of these hold:

- its artist is one of the song's artists;
- its title without the version part equals the song's (accents, case and
  punctuation folded);
- the version marks are the same on both sides: live, remix/mix, remaster,
  acoustic, edit, instrumental, demo, extended, tempo (sped up, slowed),
  re-recorded, orchestral, mono, cover. Marks are read only from the version
  part („(Live)“, „- Remastered 2011“, Deezer's `title_version`), never from
  the title itself („Live Forever“ is no live recording); guest artists name
  no version;
- the version part names the same version: its words, order, spelling of
  „remaster(ed)“/„remix(ed)“ and filler like „Version“ aside, are the same
  („Alice Remix“ is not „Bob Remix“, „Remastered 2011“ not „Remastered
  2014“, „Live at Wembley“ not „Live in Tokyo“ — nor plain „Live“). A version
  named differently on the two sides gives no sample rather than a guess;
- the length is within 3 s; when the Verlauf has no length, the album must
  match instead.

Several fitting tracks with one ISRC are one recording. Several different
recordings fit: the album decides when it singles out exactly one, otherwise
there is no sample („mehrere Aufnahmen“). None: no sample. Never the first
hit just because it is first.

## The Worker

`POST /api/history/preview` `{ trackId, playedAt }`, signed in, with the
`x-ts` header like every non-GET. The row must exist in this listener's
`plays` (song and time), else 404; malformed input 400. The row is read
under the hub's lock (read only); Deezer is asked outside it with a 6 s
deadline over the whole answer, body read and parsed included (at the
deadline the request is aborted and „timeout“ said); the session is checked again before the answer leaves, so a
sign-out meanwhile learns nothing. At most 12 lookups per listener and
minute, then a „rate“ answer without asking Deezer. Answer: `PreviewResult`
(`src/shared/api.ts`): `ready` (address, expiry, Deezer's title, artist,
album, link) | `unavailable` (`no_match`, `ambiguous`, `no_preview`) |
`error` (`denied` 401/403/OAuth, `rate` 429/quota, `timeout`, `upstream`).
`Cache-Control: no-store`. Nothing is written.

## The page

One player for the whole app (`src/client/history-preview.ts`), made on
the first tap, `preload="none"`: without a tap there is no request and no
audio. States: not asked („Hörprobe“), loading or starting („Sucht …
(abbrechen)“; starting = `play()` not answered yet),
ready („Abspielen“, when the browser wants its own tap for sound), playing
(„Stopp“), stopped („Nochmal hören“), unavailable („Keine Hörprobe“,
disabled, said why), error („Nochmal versuchen“, said why). No retries by
itself: every lookup is a tap, and one tap makes at most one lookup. A
kept address run out since is asked for again on the next tap; an address
that arrives already run out (or within 30 s of it) is said as an error,
never asked for again by itself. The sample stops at its end and never runs past 30 s.

It stops on the same key while starting or playing, and on the tab going
to the background while starting or playing. It stops and forgets the row
on: the same key while looking up,
another row's key, leaving the Verlauf, `pagehide`, signing out, another
account (then every remembered „no sample“ is forgotten too). Nothing comes
back by itself. Every answer or `play()` of an earlier tap is ignored; a
late `play()` is paused again, unless a newer start the listener asked for
is under way or playing.
Rows are told apart by song and time, so the same song twice in the Verlauf
are two rows.

The key sits in its own line after the rating keys: „Favorit“ → „Nie
wieder“ → „Hörprobe“ in focus order (unchanged before it), at least 44 px,
named with the song („Hörprobe – „Titel“ von Künstler“), the global
focus ring. CSP: `media-src https://cdnt-preview.dzcdn.net` only — nothing
else may load media.

The OS may still duck or pause other audio apps when the page plays sound;
that is device behaviour outside the app and is not promised either way.
