# Station detail read contract

TS-STATION-DETAIL-CONTRACT-261016. Tests: `test/hub/station-detail/` against
`HubCore.stationDetail` (route `GET /api/stations/:id`). Base: R5
`4cca91df8a62f78992392403398e5ec5f9aedf17`. This is a test-only addition:
no product code, dependency or schema changed.

## What the read promises

A station page shows four things. The tests hold the hub to exactly these
statements and nothing more.

**Upcoming**: the deck's songs still `pending` after the player's position,
in deck order, at most 12.

- The position is the place last seen in the player (`lastIndex`), else the
  held place (`heldAt`), else before the first song. The song at the position
  itself is not upcoming.
- Pending songs before the position, and `played`, `passed` or `skipped`
  places after it, are left out.
- Every entry carries the kind of its own deck place. The same song twice in
  the deck gives two entries, each with its own kind. `facts.kind` names the
  same kind.

**Recent**: the station's own plays that count (`ignored = 0`), newest
first, at most 15.

- Plays of another station, or of no station, never show.
- Every play is its own entry: a song heard three times shows three times.
- The play's stored metadata wins. Without it, the station's own songs or its
  finds supply it.

**Metadata gaps**: a song whose metadata the station cannot supply may be
left out. It is never invented, and the order of the rest stays. The model
does not decide whether a later song then takes the free place.

**Discoveries**: counts of the station's own finds only.

- `pending` = candidate + probation.
- `kept` and `rejected` are counted as they are.
- A find shared with another station counts once per station.

**Unknown station**: `HubError` with code `not_found` and status 404, for
example ids 0, -1, NaN, 1.5 or a missing id.

**Reads write nothing**: one read, or repeated reads, mid-session or not,
leave all of the following unchanged:

- tables: plays, memory (ratings), bans, stations (decks), discoveries,
  playback sessions, kv, jobs, events, pages, playlists;
- the alarm;
- every provider request (`FakeSpotify.calls`);
- the fake player, its queue and its recently-played list.

Two consecutive reads of unchanged state, and a read after a restart, answer
the same.

## What it does not promise

- No order among plays with the same time. The fixtures contain no ties.
- Nothing about `rated` on these entries: it is neither required nor
  required to be absent.
- Images, thumbs and the station summary fields are not part of this
  contract.

## How the tests work

| File | Role |
| --- | --- |
| `fixtures.ts` | 35 deep-frozen fixtures and the world builder, both described below. `install` writes a fixture's decks, plays and discoveries into the hub's own tables. A station the fixture does not name gets no deck. It then starts a fresh HubCore, so every read starts with cold caches. |
| `reference.ts` | The model, written from this contract and not from the hub's code. It gives `must` (required, in order), `may` (allowed, in order) and `max`. Without gaps `must` = `may`, so the answer must equal it exactly. |
| `read-contract.test.ts` | The named cases listed below. |

**The world.** The real HubCore runs on node:sqlite against the existing
FakeSpotify, built through the shared HubHarness (`makeHarness`). There are
40 songs and two playlist stations: A holds songs 0–24 and B holds 15–39, so
they share 10 songs.

**The fixtures:**

| Group | Fixtures | Covers |
| --- | --- | --- |
| Upcoming | U01–U17 | no deck; 0, 1, 12 and 13 pending; seen, held and no position; interleaved states; duplicates; a ghost song; a discovery; the overlapping station |
| Recent | R01–R13 | 0, 1, 15 and 16 plays; ignored plays; other or no station; repeats; storage order; stored metadata; missing metadata; ghost; kept find; B over shared songs |
| Discoveries | D01–D03 | discovery counts |
| Combined | C01–C02 | both stations full |

**The named cases:**

| Case | Checks |
| --- | --- |
| SD-00 | the fixture table |
| SD-01 | every fixture against the reference, with a write check on each |
| SD-02 | upcoming bounds 0, 1, 12 and 13 |
| SD-03 | the position |
| SD-04 | order and kind |
| SD-05 | recent bounds 0, 1, 15 and 16 |
| SD-06 | own plays that count |
| SD-07 | newest first; repeats |
| SD-08 | two overlapping stations |
| SD-09 | metadata gaps |
| SD-10 | discovery counts |
| SD-11 | 404 |
| SD-12 | repeated reads and a restart |
| SD-13 | state produced by real playback (45 minutes on A), read mid-session from A and B, against the reference over the stored rows |

Run them with `npx vitest run test/hub/station-detail`.

## Open observation (not a test)

The metadata lookup reads the station's own sources while the hub's
in-memory track index is cold, but the whole index once something has
built it (`lookupTracks`). The same stored state can then read
differently.

A temporary probe showed this with a synthetic state: a deck entry and a play
without stored metadata, both for a song held only by the other station. The
cold read gave 0 entries in each list; after building the index through the
private `trackIndex()` it gave 1. The probe was not committed.

It is not established that real data reaches this state:

- stored plays normally carry metadata;
- decks are built from the station's own pool;
- the index is built by the discovery job and by import inspection.

So it stays an observation, not a red contract test.
