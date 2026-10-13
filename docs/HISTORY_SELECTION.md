# Imported history selection and own-playlist counts

Product and data contract for `/auswahl` ("Hörverlauf auswählen"). Code:
`src/core/import-selection.ts` (pure rules), `src/worker/hub/hub.ts`
(storage, effective history, playlist counts), `src/client/screens/selection.tsx`.

## What is stored

An import has two parts, uploaded by the import page one after the other:

| Part | Table | Content |
| --- | --- | --- |
| Song totals | `hist_pages` (kv `history_import` with upload `id`) | per song: plays, early skips, last play/skip, plays before the first skip |
| Single plays | `listen_pages` (kv `listens`, one generation) | every export row before the first sign-in: song, end time (s), ms, flags, platform |
| Old summary | kv `history_profile` | only from apps before single plays were kept |

Rows that say nothing to the memory (under 30 s and not skipped, or a skipped
first song after a start) are stored, listed and counted as `neutralRows`;
they never had and never get any influence.

Stored rows from the moment live counting began (`live_since`) on — possible
when an export runs past the first sign-in and was stored by an older app —
are listed too (`afterLive`, `afterLiveRows`) and contribute nothing from the
import: that time belongs to true-shuffle's own count, so nothing is counted
twice. The page says so without claiming that true-shuffle observed every
later play: it holds only what it observed itself.

## Selection rules

`kv history_selection = { revision, appliedAt, enabled, rules[] }` per listener
(UserHub Durable Object; no cross-account state).

- **Zeitraum ausschließen** — whole calendar days `from`..`to`, both inclusive,
  in the IANA zone stored with the rule (the browser's zone when added). A play
  belongs to the moment Spotify says it ended (`ts`). Day start is the first
  moment whose local time is that midnight or later: a skipped midnight
  (America/Santiago) starts the day at 01:00, a skipped calendar day
  (Pacific/Apia 2011-12-30) holds no moment.
- **Künstler** ein/aus — matched on the export's album artist, case and spacing
  folded.
- **Song** ein/aus — matched on the export's Spotify track id. Other releases or
  relinked ids of the same recording are different ids.
- **Nur-Summen ausschließen** — songs that have totals but no single plays.

Resolution, per imported play: the song rule if any, else the artist rule,
else a matching period, else the play counts. Overlapping periods simply all
exclude; each play is decided once (no double counting). "2024 excluded, this
song included" keeps exactly that song's 2024 plays. Totals-only songs can only
be decided by a song rule or the totals-only rule: they have no dates or artist
to apply other rules to, and no single plays are ever invented for them.

Identical selections are canonical (deduplicated by rule key, sorted); applying
the same selection again changes nothing (no revision, no write).

## Effective history

- Never changed / no rules / enabled: the stored totals, exactly as before this
  feature (no migration of meaning for existing listeners).
- Switched off: no imported influence at all; data and rules stay.
- Rules: songs whose plays no rule touches keep their stored totals unchanged.
  A song that loses any play is counted again from the plays it keeps (same
  rules as the import: >= 30 s is a play; early skips except openers). The
  selection only takes away; it never adds a song the totals did not have.
  The changed songs are stored as one generation in `hist_effective`
  (kv `history_effective` binds it to the selection revision and the stored
  import). If it cannot be computed the import counts for **nothing** (shown
  as an error), never for everything.

Every consumer reads the same selection: `memory()` (planner ranking input:
taste weight, staleness, favourite-by-behaviour, retests, song facts,
discovery "known" check), the Hörprofil timeline and the AI genre request.
Live plays, thumbs, Spotify hearts, verdicts, bans, guest rules, stations and
the saved queue are separate tables and are never written by a selection.

An applied change marks decks for re-planning **only when no saved session
holds them** (same rule as a new import): normal Play keeps the same queue
occurrence and position; a new queue (explicit) is planned with the selection.
A stored or pending genre estimate is dropped (it came from the old history).

## Explicit takeover, races, stale tabs

- Search, grouping, filters, sorting and drafting are read-only
  (`POST /api/history/selection/preview`).
- `POST /api/history/selection` must name the revision the page shows
  (`baseRevision`) and the stored import it was made on (`dataset`, the
  preview's or the page's dataset key — required). Missing, null or empty:
  400; another revision or another stored import (replaced or deleted since,
  also at the same revision): 409. Both are checked before anything else, also
  before an unchanged selection is answered as such; nothing changes. The
  selection is computed before anything is written, then saved in one
  transaction.
- The page drops answers to older previews (sequence) and never shows an older
  revision as in force. "Auswahl übernehmen" is enabled only after a successful
  preview of exactly the current draft on the current revision of the current
  stored import; a failed or pending preview shows no counts as the draft's.
  After a 409 the page reloads, counts the unchanged draft again and waits for
  a new deliberate takeover.
- Row actions and "all matches" act only when the rows shown were found by
  exactly the current search, grouping, filter, order and page, counted under
  the current draft and revision of the current import. Otherwise they are
  locked (and said so) until that count arrives.
- Edits made while a takeover or switch is on its way stay the draft: an
  answer replaces the draft only if it was not edited since it was sent, and
  then says that later edits are not taken over yet. A deletion or a conflict
  never resets the draft.
- One change at a time: taking over, switching on/off and deleting are
  serialized (buttons and handlers, also an already open deletion
  confirmation and quick double taps).
- Order of answers: the order requests are sent in proves nothing about the
  order the server stored or read things in (a reload sent after a takeover can
  be read before the takeover is stored). So the view and every change's answer
  carry `commit`, a number per listener that counts up, in the same storage
  transaction, with every stored change of the import or the selection: a
  change taken over (also switching on/off), a finished import of totals or of
  single plays, a deletion, a first legacy summary (see `importChanged`,
  `importCommitted` in the hub). Reads, previews, an unchanged selection sent
  again, refused or stale requests, upload blocks before the last and a
  repeated summary do not move it; it is stored in the `kv` table (no schema
  change, starts at 0 for stored listeners) and survives reopening the hub.
  Each of these changes — its data, the end of its upload and the number — is
  stored in one transaction (`importTransaction`; `transactionSync` in the
  Durable Object): a failure anywhere in it, before or after the number is
  written, leaves everything stored as it was, drops whatever was cached in
  memory during it, and keeps the upload, so the same last block (or the same
  summary) can be sent again and then counts exactly once.
  The deletion answer carries it too. The page shows a view only if its
  `commit` is higher than the one shown (equal: the same stored import and
  selection — then the later sent answer wins, they differ at most in an
  upload under way), and never a lower revision. A change's answer with a lower
  `commit` than shown (a later change was shown already: another tab, a
  deletion, a new import) shows and claims nothing; with an equal or higher one
  it is reported. A deletion's answer with a higher `commit` than shown
  replaces the shown import at once by a stand-in with nothing to act on, until
  a load arrives. An answer not used changes nothing — view, draft, message,
  error or busy state.
- A change that is refused or lost (an error answer, no connection) is said
  ("Nicht übernommen", "Nicht gelöscht") as long as the page shows the stored
  state the change was made on — also when a reload of that same state came
  back meanwhile. Only when a later stored change is shown (another tab
  replaced or deleted the import: a higher `commit`) does its failure describe
  nothing on the page and is left out. The draft stays; the change can be sent
  again on purpose.
- Failures are ordered by themselves: a failed load is shown only if it was
  sent after every request answered so far and after the failure shown, so an
  older failure never replaces a newer one, a newer view, a change's answer or
  a deletion. Any newer answer clears an older failure; "Neu laden" stays.

## Uploads, re-import, deactivation and deletion

- An import is begun on purpose (`POST /api/history/begin`): the answer
  names the import epoch, and the first totals block must carry it. A deletion
  moves the epoch on, so a first block sent before it (late, another tab) is
  refused. A first block without an epoch (an app from before) is taken only as
  long as nothing was ever deleted.
- Totals are staged in `hist_stage` and replace `hist_pages` only with the last
  block. Every later block must name the upload under way (`upload` id, always
  required) and come in its place; position and count alone are no identity. A
  deletion or a new first block replaces the upload under way, so late blocks
  of the old one — named or not — are refused, also after a restart.
- Single plays name the totals upload they belong to (`importId`) and are
  refused for any other, and after a deletion. Plays without `importId` (an app
  from before) are taken only with totals stored before uploads were named, or
  with no totals and never a deletion. When newer totals arrive, single plays
  still on their way are abandoned (their remaining blocks are refused).
- Only single plays that belong to the stored totals are read by any consumer
  (selection, Hörprofil, genre request, inspection). Plays of an older import,
  left when a newer one came as totals only, belong to nothing current; they go
  with a deletion or the next upload.
- A song whose stored single plays do not account for its stored totals (other
  numbers of plays or early skips) is **partly covered**: periods and artists
  cannot be applied to plays that were never stored, so it is decided only as a
  whole — by a song rule or the "Songs ohne vollständige einzelne Wiedergaben"
  rule — in the memory and the Hörprofil alike, and shown as such
  (`partialSongs`, `partialPlays`, item `partial`). Nothing is inferred about
  the missing plays; a deliberate re-import makes the selection exact.
- A new import (a deliberate, separate action) **replaces** the stored one.
  Duplicates inside one upload are folded (same second + song). The saved rules
  and the on/off switch apply to the new data: importing the same files again
  gives the same effective history; a switched-off import stays off until
  switched on.
- Delete (`POST /api/history/delete`) names the stored import (`dataset` key);
  a changed import is refused (409). It removes totals, single plays, staged and
  effective pages, the old summary, uploads under way and the genre estimate —
  nothing else. The rules stay for a later import and say so. The Spotify files
  outside the app are not touched. Cancel sends nothing.

## Own-playlist counts

`POST /api/playlist-counts` starts a count (never automatic). It reads the
playlist list (unless read within 10 minutes) and then every own playlist page
by page through the existing job queue, request budget and confirmed
operation waits (genuine `Retry-After`, no retries inside a wait).

- Own = `owner.id` is the signed-in listener. Not counted: playlists of
  stations and the discoveries playlist (known ids), others' playlists
  (followed or collaborative), and owned playlists named like true-shuffle's
  without a known id ("Herkunft unklar", listed by name). Names never replace a
  known id.
- Independent of which playlists feed stations and of the history selection;
  it changes no weighting.
- Each playlist counts a song once, however often it is in it. Local files and
  episodes are skipped; ids are the ones Spotify returns with
  `market=from_token` (same convention as the station pool).
- Unchanged playlists (same `snapshot_id`, fully read) are not read again.
- A playlist that is forbidden, gone, answers nothing, returns an empty page
  while announcing more (`next`), a running count, one given up after repeated
  failures, a playlist list that could not be read again for this count, or any
  playlist of unclear origin makes the count **incomplete**: a song then shows
  "mindestens n" (in the queue tags too), and 0 shows as "unbekannt" (no tag),
  never as none.

## Favourites and the mix

Explicit signals stay favourites regardless of the import: thumb up and
Spotify hearts. A song becomes a favourite by behaviour when it was heard at
least 5 times and skipped early at most a fifth as often — imported plays
count towards that only as far as the selection keeps them. How often
favourites play is the station's mix / favourite share (unchanged); the
playlist count does not feed it.

## Not covered / limits

- Live Spotify, real exports, physical devices and HA/MA: NOT_RUN for this
  change; tests use FakeSpotify and synthetic data only.
- Shuffle-mode, listening-time or platform rules are possible later (the single
  plays carry those flags) but are not part of this change.
