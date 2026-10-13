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
  (`baseRevision`); otherwise 409 and nothing changes. The selection is computed
  before anything is written, then saved in one transaction.
- The page drops answers to older previews (sequence) and never shows an older
  revision as in force.

## Uploads, re-import, deactivation and deletion

- Totals are staged in `hist_stage` and replace `hist_pages` only with the last
  block. Every later block must belong to the upload under way (`upload` id and
  position); a deletion clears it, so late blocks are refused.
- Single plays name the totals upload they belong to (`importId`); after a
  deletion or a newer import they are refused. (Apps from before send no
  `importId`; their totals upload is refused after a deletion instead.)
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
