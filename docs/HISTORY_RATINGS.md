# Ratings right in the Verlauf (HUI-01 – HUI-07)

Baseline: `a858098dc278492870ad04699e9d5c33cb1c43a0` (held feature branch
`claude/history-personalization-playlist-counts`, Draft PR 30). This change
adds a UI option, an additive rating-with-receipt contract and its guarded
undo. No migration, schema, binding, Durable Object identity, auth, ingest,
cutoff or weighting change. Audio stays BLOCKED: no preview source, audio
fetch, embed or SDK path exists in this change.

## HUI-01 — the option

- Mehr → App → „Bewertungen im Verlauf direkt anzeigen“ (a switch).
- Stored in `localStorage` under `ts-history-ratings:<Spotify account id>` =
  `"on"`; anything else (missing, another value, another account's key,
  unreadable storage) means **off**. Per device/browser and per account; Siri,
  other devices and the server are not touched. If the browser keeps no
  settings, the switch works until reload and says so.
- Off: the Verlauf renders exactly as before (whole-row `RateHit` opening the
  rating sheet, `ThumbMark`). Switching or viewing writes nothing; stored
  ratings stay and show in either mode.

## HUI-02/03 — every row, one change at a time

- On: every Verlauf row (all pages, outside true-shuffle, guest plays, every
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
| Verlauf, option off | whole row is a text-less button opening the sheet (click, not long-press) | page text „Tippe auf einen Song, um ihn zu bewerten.“ | tap; Tab reaches one unlabelled-looking full-row button per song (named „… bewerten“) | `src/client/screens/menu.tsx` (HistoryScreen, `RateHit`), `src/client/components/rate.tsx` `RateHit`, `.track__hit` in `app.css` | KEEP as the off mode |
| Verlauf, option on | labelled keys per row, undo, status | keys themselves | 44 px keys, Tab/Enter/Space | this change | IMPROVE (implemented) |
| Home queue | same full-row `RateHit` over each queue row | none in the row | tap; Tab per row | `src/client/screens/home.tsx` queue row (`RateHit t={track}`) | IMPROVE recommended (same option pattern), not implemented here |
| Station song list | same full-row `RateHit` | none in the row | tap; Tab per row | `src/client/screens/station.tsx` song row (`RateHit t={t}`) | IMPROVE recommended, not implemented here |
| Player (now playing) | visible „Daumen hoch: Favorit“ / „Daumen runter“ keys | labelled keys | tap, keyboard | `src/client/screens/home.tsx` transport keys (`tkey`) | KEEP |
| Rating sheet | two labelled keys; same vote again resets to 0; closes after the answer, also on error | state line („Ist Favorit …“) | dialog, Esc | `src/client/components/rate.tsx` `RateSheet` | IMPROVE recommended (keep open on error, no undo there); unchanged here |
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
  listening): option off/default/invalid/foreign/unreadable storage/other
  device/no writes/ratings kept; every row incl. older page, outside, guest,
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
