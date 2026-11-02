# Ratings right in the Verlauf (HUI-01 – HUI-07)

Baseline: `a858098dc278492870ad04699e9d5c33cb1c43a0` (held feature branch
`claude/history-personalization-playlist-counts`, Draft PR 30). This change
adds ratings in every Verlauf row, an additive rating-with-receipt contract
and its guarded undo. No migration, schema, binding, Durable Object identity, auth, ingest,
cutoff or weighting change. Audio stays BLOCKED: no preview source, audio
fetch, embed or SDK path exists in this change.

## HUI-01 — always there (owner correction 2026-10-14)

- Every Verlauf row shows „Favorit“ (heart, as on the deck) and „Nie wieder“
  (thumb down), always. There is no option: the former switch under
  Mehr → App („Bewertungen im Verlauf direkt anzeigen“, default off, kept per
  device in `localStorage`) is removed, and nothing reads that key any more —
  whatever a browser stored there (on, off, another value, another account's
  key) or cannot store (blocked storage) changes nothing; the app neither
  reads nor deletes the old values.
- Viewing writes nothing; only a tap on a key writes, as before. The old
  whole-row button that opened the rating sheet is gone from the Verlauf (the
  sheet stays on the deck pages and the queue).

## HUI-02/03 — every row, one change at a time

- Every Verlauf row (all pages, outside true-shuffle, guest plays, every
  occurrence of a song) gets a second line with labelled keys „Favorit“ and
  „Nie wieder“ (`aria-pressed`), at least 44 × 44 CSS px, inside a
  `fieldset` with a named legend, no overlay over the row. Tapping the set key
  again clears the rating. A guest play stays a guest play.
- Per song one change at a time, shared by all its rows; keys are
  `aria-disabled` (still focusable) while it runs. States: „Wird gespeichert …“
  → „Gespeichert: …“ / „Nicht gespeichert: … [Nochmal speichern]“ /
  „Unklar, ob gespeichert … [Nachsehen]“ / „Inzwischen anders bewertet (jetzt:
  …)“. A page-level live region repeats the last outcome.
- An answer counts only for the newest operation on the song and only while
  the same session is signed in: the controller follows the app's sign-in
  state itself (signing out — wherever the app is — or another account starts
  from nothing, also when signing in again as the same account; loading, a
  failed refresh or being offline change nothing). Verlauf lists (first page
  and „Ältere laden“) count only for the page and session that asked.
- A rating given meanwhile elsewhere in this app (rating sheet, player keys)
  shows over an older confirmation or list read; a list read after it wins
  again. Value and write number shown always come from one source. „After
  it“ is decided by identity, not by the clock (both can fall in one
  millisecond): a Verlauf list remembers the app's rating objects standing
  when it was asked for (`startListRead`); with its answer (`takeListed`)
  exactly those give way — on the first page also app-wide
  (`store.settleKnownThumbs`, additive; `settleThumbs` of the other screens is
  unchanged) — and one given while the list was on its way stays.
- A receipt proves that its action happened, not that its value holds now
  (HUI-RT-001). A confirmation (answer or receipt) is taken only when it is
  neither taken back nor superseded, its number is not below the newest one
  known here (list read or earlier confirmation) and nothing was rated in this
  app while it was asked for (the store's rating object is compared by
  identity, not by clock). Otherwise the page reads the song's rating now
  (`current` of the receipt lookup) under the same rule and says „Gespeichert
  war: X — inzwischen anders bewertet (jetzt: Y)“ or „Gespeichert, aber schon
  zurückgenommen“; if that read fails, the newer known state stays and the
  row says so. Old „rated since“ and undo answers follow the same rule. Only
  a taken rating reaches the rest of the app (`setThumb`).
- No answer in time (the page's 15 s): the request may still arrive. That
  stays with the decision (`mayStillArrive`) for every later look: a lookup
  saying „not yet“ is „Unklar … Bisher nicht angekommen, kann aber noch
  ankommen“, however often „Nachsehen“ is used (HUI-RT-002); never „Nicht
  gespeichert“. The row offers „Nachsehen“ and „Nochmal speichern“ (same id,
  same basis — stored at most once, never skipped twice). A certain refusal
  (4xx) is „Nicht gespeichert“ without a lookup; so is a lost answer without
  a timeout (offline, 5xx) whose lookup proves „not yet“. Nothing is sent by
  itself.
- A refusal (4xx, e.g. 429) of „Nochmal speichern“ is the refusal of that
  attempt only: while an earlier attempt of the same decision ran out of time
  and may still arrive (`mayStillArrive`), the row stays „Unklar … Dieser
  Versuch wurde abgelehnt (…); der frühere kann aber noch ankommen“, also in
  the live region, with „Nachsehen“ and the same id; the intent keeps its
  uncertainty through any number of refused retries and looks. When the
  original arrives it is stored once (receipt by id) and the next look finds
  it. Only a decision with no attempt still open is „Nicht gespeichert“ on a
  refusal.

### Server contract (additive)

- `POST /api/history/ratings {actionId, trackId, value, basis}` →
  `{kind:"done", receipt}` or `{kind:"changed", current:{value, seq}}`.
  - `actionId`: the page's id for one decision (8–64 `[A-Za-z0-9_-]`); sent
    again it is answered from its receipt — never stored or skipped twice.
    Reused for another song/value: 409.
  - `basis`: the song's rating write number as the page read it
    (`HistoryEntry.rated`). Stored only when it equals the song's number now
    (`ratedSeq === basis`); rated since (here, another tab, the sheet, Siri) or
    a number the song never had (another account, a reset, made up) →
    `changed`, nothing stored.
- `GET /api/history/ratings/:actionId?track=&basis=` (after a lost answer;
  `track` and `basis` each optional) → `{receipt, stored, current?}`. Only the
  newest 100 receipts are kept, so a missing receipt alone proves nothing:
  `stored:"no"` only when the song's number is still exactly `basis`;
  otherwise `"unknown"` → the page says „unklar“, offers only
  „Nachsehen“/reload, never a second write. With `track`, `current:{value,
  seq}` is the song's rating and write number at this read (additive).
- Rating clock (`kv rating_clock`, bounded to the 500 songs rated last, with a
  floor as upper bound for the rest) and receipts (`kv rating_receipts`, 100)
  are written by every rating path — `thumb()` (sheet, player keys, Siri,
  remote) included, which keeps its semantics and answer. A later rating of a
  song marks its earlier receipts superseded.
- All data writes of a rating and its bookkeeping run in one storage
  transaction (`ratingTransaction`); on any failure the in-memory memory rows
  and station list are dropped and pools recounted — no stale read after a
  rollback. The skip (below) runs after the transaction; its outcome is kept in
  the receipt separately.

## HUI-04 — taking back (guarded undo)

`POST /api/history/ratings/:actionId/undo` (idempotent) takes back exactly what
that rating changed and nothing changed again since. A receipt is outdated —
undo is a conflict, nothing changes — when the song was rated again by any path
*or* its exact rating number is no longer known (the clock forgot the song):
`superseded || ratedSeq(track) !== receipt.seq`. A receipt pushed out of the
kept ones while its skip was on its way is never brought back.

| Effect of the rating | Taken back when | Otherwise |
|---|---|---|
| `memory.thumb` | the receipt is not superseded (no later rating by any path) | **conflict**: nothing changes, said |
| memory row it created | the row is still exactly as it made it → deleted | rating set back, row kept |
| discoveries rewritten (`-1` → rejected, `+1` → kept) | the whole row is still exactly as written (status, time stamp, heard, …) → status/time back | kept, said („weiterentwickelt“) |
| station bans lifted (`+1`) | no ban for that station now → re-inserted with its old time | newer ban kept |
| deck watch list `formerOff` extended (`-1`) | the deck's plan (version, songs, former versions) is unchanged → entry removed | kept, said („neu geplant“) |
| decks asked to plan anew (`deck_dirty`) | always asked again (never withdrawn: the request may be someone else's too); a saved queue keeps its order (NN-03) | — |
| hand-over to the Spotify discoveries playlist (`keep:<id>` job) | its own job, never tried and untouched since (same created/updated stamps, 0 attempts) → called off | tried already → called off but **unclear** whether it reached Spotify; already done, or replaced by a later job → stays; said. true-shuffle never removes anything from that playlist. |
| skip of the song playing (`-1`) | **never** taken back or repeated | said at the undo key: „Rückgängig (Überspringen bleibt)“ |

Outcome `undone` / `partial` (notes say what stayed) / `conflict`. Undo never
touches playback. A receipt pushed out of the 100 kept ones can no longer be
taken back. On the page, a refused undo („Nicht zurückgenommen“, with „Nochmal
zurücknehmen“) and an unknown outcome (lost answer and receipt unreadable or no
longer kept: „Unklar, ob zurückgenommen“, with „Nachsehen“) are kept apart,
also in the live region; nothing is sent again by itself.

## HUI-05 — playback boundary

**Changed by CTO-04 (2026-10-15): the Verlauf rates only, it never skips.**
`rateFromHistory` no longer calls a skip (`skipForHistory` is gone); every new
receipt says `skip:"none"`, also for „Nie wieder“ on the song playing, with no
player read and no `next`. The hint before „Nie wieder“ says so for Spotify
too: „Läuft gerade in Spotify: „Nie wieder“ speichert nur die Bewertung, der
Song läuft weiter.“ Receipts stored before keep their skip outcome and are
still shown as before (storage and API shape unchanged). The rest of this
section describes the behaviour before 2026-10-15 and is kept as history.
Home, the rating sheet, Siri and the remote: see the next section (the old
`skipIfPlaying` is gone since 2026-10-15).

### CTO playback boundary (2026-10-15)

`POST /api/tracks/:id/thumb` and `/retest` accept an optional
`expected: { sessionId, entryId }` — the queue occurrence shown when the
answer was given. Old payloads stay accepted, responses keep their shape
(`{ skipped, skipError? }`), storage is unchanged.

- **With `expected`** (Home's player keys and retest, `src/client/home-answers.ts`):
  "Nie wieder" / "Eher nicht" skips exactly that occurrence and only while it
  is the one playing (`HubCore.skipOccurrence`). The decisive check runs inside
  the serialized command (`playerAction("next", expected)`) after a fresh
  player read and after any command queued before it: a late answer for an
  earlier occurrence — also of the same song, also after an explicitly new
  queue — skips nothing. Refused or unclear at that moment: not skipped, the
  reason in `skipError`, shown apart from a storage failure.
- **Without `expected`** (the rating sheet, the fallback client, a page loaded
  before this change): **legacy behaviour change** — the rating is stored, the
  song is never skipped from it (`{ skipped: false }`). Authority: the CTO
  requirement that an unclear or unassignable playback never gets an
  automatic "next" from an old rating. Before, such a "Nie wieder" skipped the
  song if a fresh read still showed it playing.
- **No binding, no automatic skip — on every path.** `HubCore.thumb` /
  `retestVerdict` called with no binding (left out or `null`) only rate;
  the former unbound `skipIfPlaying` (song id only) is removed. Siri and the
  remote bind to the saved queue's entry playing now when that is the very
  song they just read; otherwise they rate and say „Er läuft noch zu Ende.“
- **Not at a later look either (station guard).** A stored "Nie wieder" is
  song-wide and stays so: every play of the song that begins after it is
  moved on as before. But a "Nie wieder" not attributed to the play running
  when it is stored — a late answer for an earlier occurrence, one naming no
  play, the rating sheet, the Verlauf — notes the song, the time and the
  saved-queue entry then current (kv `guard_spare`, kept with the other kv
  state, so over a restart). The guard spares a play of that song while that
  entry is still current, or while the observed play began no later than the
  note — also a newer play the hub has not observed yet. A note goes only
  once a later play has begun and its entry is no longer current; never for
  age (a long pause) or because of other ratings. An answer attributed to
  the occurrence still current notes nothing: a skip of it that failed stays
  the guard's to retry. Authority: CTO, 2026-10-15 („Bei nicht sicher
  zuordenbarer Wiedergabe kein automatisches Next aus alter Bewertung“); this
  was earlier wrongly listed as a pending owner decision.
- **Not covered by a local check:** a player moved by someone else between the
  final check and Spotify's "next" (Spotify's "next" names no entry).

### Rating sheet (`src/client/components/rate.tsx`, 2026-10-15)

A refusal keeps the sheet open on the same song with the reason, the choice
that was not stored and „Nochmal speichern“ („Nicht gespeichert“); a lost
answer (no connection, timeout, a broken answer — the rating may be stored
all the same) says „Speicherung nicht bestätigt“ with the same retry; no success is
said before the server stored it, and only a stored answer closes the sheet.
„Abbrechen“ stays possible while it is on its way. An answer belongs to its
own request, its own opening of the sheet and its own sign-in: one arriving
after the sheet was closed, reopened (also for the same song) or after a
sign-out or another account neither closes nor fills the newer sheet; a stored
rating still shows in the lists, a refusal is said as a message naming the
song. A key on its way cannot be pressed again for the same song. A stored
rating whose skip failed is said as such, apart from „Nicht gespeichert“.

- Before „Nie wieder“ on the song playing now the row says what it would do,
  by the controller of the confirmed session (HUI-RT-004): Spotify — „Läuft
  gerade in Spotify: „Nie wieder“ überspringt ihn, wenn er beim Speichern noch
  läuft.“; Home Assistant (`controller.kind === "home-assistant"`, native) —
  „Läuft gerade über Home Assistant: „Nie wieder“ speichert nur die Bewertung,
  dort wird nicht übersprungen.“ No new native skip. The hint is rendered
  apart from the status (`.hist-rate__hint` beside `.hist-rate__status`) and
  stays whenever „Nie wieder“ can be tapped — also after a refusal, „rated
  since“, a failed or unclear undo, an unclear save (HUI-RT-005); not while a
  change runs, not when the song is already „Nie wieder“.
- The History path has its own skip, `skipForHistory` (same rule: identical
  current id, a fresh read when the snapshot says so, native never skipped,
  one attempt). Every outcome is in the receipt (HUI-RT-003): `skip:"failed"`
  with `skipStage:"read"` when the fresh read failed (503, quota, offline —
  nothing skipped, nothing tried again: „ob der Song noch läuft, ließ sich
  nicht prüfen (…) — Überspringen fehlgeschlagen, kein neuer Versuch“), or
  `skipStage:"next"` when Spotify refused the skip („Bewertung gespeichert;
  Überspringen fehlgeschlagen: …“), or unknown („pending“: never retried).
  Sent again it is answered from the receipt: no new read, at most one skip.
- `skipIfPlaying` — the rating sheet, player keys, Siri and remote — is
  unchanged: a failed fresh read there still means „not skipped“ with the old
  answer `{skipped:false}`.

## HUI-07 — discoverability audit (bounded)

| Place | Actual access | Visible hint | Touch / keyboard | Evidence | Disposition |
|---|---|---|---|---|---|
| Verlauf | labelled keys per row, undo, status — always (former off mode with the whole-row sheet button removed 2026-10-14) | keys themselves | 44 px keys, Tab/Enter/Space | `src/client/screens/menu.tsx` (`RatedHistoryRow`) | IMPROVE (implemented) |
| Home queue | same full-row `RateHit` over each queue row | none in the row | tap; Tab per row | `src/client/screens/home.tsx` queue row (`RateHit t={track}`) | IMPROVE recommended (same keys as the Verlauf), not implemented here |
| Station song list | same full-row `RateHit` | none in the row | tap; Tab per row | `src/client/screens/station.tsx` song row (`RateHit t={t}`) | IMPROVE recommended, not implemented here |
| Player (now playing) | visible „Daumen hoch: Favorit“ / „Daumen runter“ keys | labelled keys | tap, keyboard | `src/client/screens/home.tsx` transport keys (`tkey`) | KEEP |
| Rating sheet | two labelled keys; same vote again resets to 0; closes only after a stored answer, stays open with the reason and „Nochmal speichern“ on error (2026-10-15) | state line („Ist Favorit …“) | dialog, Esc | `src/client/components/rate.tsx` `RateSheet` | IMPROVED 2026-10-15 (no undo there) |
| Station fold | visible `summary` | summary text | keyboard via `details` | `src/client/screens/station.tsx` `details.fold` | KEEP |
| Import hint after first sign-in | „Alles in diesen Dateien lief nach deiner ersten Anmeldung …“ | text | — | `src/client/screens/menu.tsx` ImportScreen | DEFER (wording, separate package) |

This is a code audit plus the browser tests below; no full inventory of every
hidden function and no user study is claimed.

## Tests

- `test/client/history-ratings.test.ts` (controller with held answers): session
  reset on signing out/in outside the Verlauf, loading/offline not resetting,
  stale list generations, sheet rating shown, undo refused/unknown/unclear and
  its announcement, timeout unclear, retry with the same id; HUI-RT-001 held
  answers after a newer list or sheet rating (same millisecond and ordered
  times), current unreadable, lost answers with a taken-back or superseded
  receipt, old „rated since“ and undo answers, sign-out fence; HUI-RT-002
  repeated looks after a timeout, later arrival, same-id resend, certain 4xx;
  HUI-RT-002 residual (`test/client/history-ratings-retry.test.ts`, real
  store + controller + HubCore): timeout → same-id retries refused 429/400 →
  looks stay unclear → original commits once (+1, one receipt, seq +1) and is
  found; „Nie wieder“ on the song playing: one skip; a first refusal and a
  refusal with nothing open stay „Nicht gespeichert“;
  status and playback hint (Spotify/native, kept after failures).
- `test/client/history-ratings-list.test.ts` (real store + controller, list
  read as the Verlauf reads it): a +1 confirmed in the millisecond the list
  was asked for gives way to its newer -1 (keys, app-wide override, number;
  first and older pages); a held list after a sheet rating in the same
  millisecond keeps the sheet's rating; a list of a signed-out session counts
  for nothing.
- `test/hub/history-ratings.test.ts` (Node HubCore + FakeSpotify): receipts,
  replay, reuse, exact basis (incl. a basis below the account's newest number),
  stored-proof incl. pruned receipts, undo 0/1/-1, conflicts (later rating,
  discovery changed in the same millisecond, deck re-planned with the same
  version stamp, newer ban, replaced/touched/foreign keep job), combined
  partial undo writing nothing over newer state, skip once/never repeated/never
  undone, skip refused (`skipStage:"next"`), fresh read failing with 503,
  quota and no connection (`skipStage:"read"`, rating stored, no next, no new
  read on replay), exactly one skip on replay, other song, native, sheet/Siri
  unchanged, lookup `current`, storage faults at the clock/receipt (rate and undo)
  with immediate and reopened reads, restart, account isolation, bounds.
- `e2e/history-ratings.spec.ts` (real Worker, Spotify stand-in; plays made by
  listening): keys always there — by default, whatever the removed switch
  stored (on/off/invalid/foreign), on another device, with blocked storage
  (save, undo, conflict, no playback or audio) — no switch left, viewing
  writes nothing, ratings kept over a reload; every row incl. older page, outside, guest,
  three occurrences; slow/double/keyboard, 503, offline, lost answer, lost
  answer + unreadable receipt, pruned receipt, other tab; undo none/favourite
  and conflict with the old route; timeout looked at twice, „Nochmal
  speichern“ refused with a synthetic 429 (unclear, live region, „Nachsehen“
  kept, same id), the original arriving later (one write); skip hint (Spotify wording, kept beside an enabled „Nie
  wieder“ after a 400)/skip/skip refused/undo never moving playback; 320/390/1280/640 (= 1280 at 200 %) px, 44 px, no overlay,
  keyboard, live region, no audio element or request.

Not run: real devices/iPhone/screen readers, live Spotify, owner data,
production. The 200 % zoom case is the CSS-pixel equivalent viewport, not a
browser zoom setting. The six operating surfaces (TS_DESIGN) do not exist at
this baseline: only `playwright.config.ts` sets `ts-design`, no source reads it
— not applicable here.

Browser fixture history (kept as failed logs): the first four full runs failed
in the seed, not in the UI — the stand-in dates a play by when it ends,
counted back from the moment of advancing; advancing past the guest song dated
it before guest mode came on, which the Worker rightly counted as the owner's.
Fixed by the stand-in control `finish` (the playing song ends now). The fifth
run failed because Playwright's `dblclick` waits while a key is
`aria-disabled`; it tapped only after the page's 15 s timeout (two separate
real requests). Fixed by a forced pointer double tap on the greyed key; the
count of one request and all product assertions are unchanged. That run also
showed that a timed-out request was reported „Nicht gespeichert“ although it
could still arrive — the product now says „unklar“ there.

Repair HUI-RT-001 … 005 (independent review of manifest 0aa328e1): the
reviewer's probes, copied and only re-pointed at this tree (imports, artifact
root, port, freshly built client), and the own regressions above cover the
five findings; see the repair root's handoff for the old/new comparison.
