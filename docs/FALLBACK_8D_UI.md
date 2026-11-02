# Fallback surface: the 8d client over the current backend

A way back from the current surface **without** going back to the 8d backend.
Status: local candidate, AUTHOR_FIXED / PENDING_INDEPENDENT_REVIEW. Not deployed.

## Why not simply 8d again

The 8d backend (`8d62138184be9397ea22d55170928a4edbbc0725`) opens the current
storage (schema 8) without deleting anything, but it does not know two
contracts of the current backend:

- **REL-RBK-IMPORT** — the import selection (`kv history_selection`: switched
  off, song/artist/period rules). 8d ignores it: a switched-off import counts
  again (4 plays instead of 0).
- **REL-RBK-RATING** — the rating clock and receipts. A rating made under 8d
  does not move the clock; back on the current backend an older Verlauf
  receipt can then be taken back over it (a later -1 became 0).

Synthetic evidence: `release-preflight-b201-20261014`, 5 cross-version
probes, 3 PASS / 2 FAIL (kept unchanged).

## What the fallback is

| Part | Source | Changed? |
|---|---|---|
| Worker (Hono, UserHub, HubCore, storage, selection, rating clock, receipts, fences) | `src/worker`, `src/core`, `src/shared` of b201 | **no** — the bundle is byte-identical to b201's |
| `wrangler.jsonc` (name, bindings, Durable Objects, migration `v1`, crons, assets path) | b201 | **no** |
| Client (the surface) | `src/client-fallback-8d/` = 8d's `src/client`, copied unchanged, then 5 files changed (below) | yes, marked `FALLBACK-COMPAT` |

The current surface (`src/client`) stays in the tree, unchanged; switching
forward again is the normal b201 build.

### Building

```
npm run build:fallback     # vite build -c vite.fallback.config.ts → dist/client
npx wrangler deploy        # unchanged wrangler.jsonc: current Worker + fallback assets
```

`npm run build` (current surface) is unchanged. Both builds write
`dist/client`, which the unchanged `wrangler.jsonc` serves; deploy exactly one
of them. Back to the current surface: `npm run build && npx wrangler deploy`.

### The 5 changed files of the 8d client

1. `api.ts` — the current import protocol: `startImport()` (`POST
   /api/history/begin`), `importHistory(rows, part, parts, upload?, start?)`,
   `importListens({… importId? …})`. The 8d client sent neither: under the
   current backend a multi-block upload is refused after the first block, and
   the plays of a one-block upload are refused (they name no import) — the
   stored plays would no longer belong to the totals. The server's fences
   (begin epoch, upload id, dataset binding) are **not** loosened.
2. `screens/menu.tsx` — the import page sends that protocol (as
   `src/client/screens/menu.tsx` does); the counts say the import selection
   in force, read only: effective songs, „Import ausgeschaltet: er zählt
   gerade nicht.“ or „N Auswahlregeln aktiv: X von Y Songs prägen dein
   Profil.“, and „Die Auswahl lässt sich in dieser Ausgabe von true-shuffle
   nicht ändern; sie gilt weiter.“ The import notice says a new import stays
   switched off / under the rules.
3. `screens/home.tsx`, 4. `screens/station.tsx` — „eingerechnet“ and the
   „known“ tags use `effectiveTracks` (what counts), not the stored total.
5. `index.html` — `<meta name="ts-surface" content="fallback-8d">`, so the
   served surface can be told apart.

## What stays, on purpose

- **Import selection**: stored and applied by the Worker as before — switched
  off stays off; song, artist and period rules stay in force, also for a new
  import made on the fallback surface (`importChanged` keeps the selection).
  Nothing is reset or deleted. The fallback surface has **no** selection
  page (`/auswahl` opens „Jetzt“), no switch, no deletion of the import: these
  return with the current surface.
- **Ratings**: the 8d rating sheet and the „Jetzt“ keys post
  `/api/tracks/:id/thumb`, which on the
  current Worker moves the rating clock and supersedes older receipts. Back on
  the current surface an older receipt is a **conflict** — the later rating
  stays; the same decision sent again is answered from its receipt; a new
  decision on a number read before is refused as rated since. „Nie wieder“ on
  the song playing skips as the 8d sheet always did (one attempt); taking back
  never moves playback.
- **Everything else of the current backend** (history receipts, selection
  APIs, playlist counts, quota/usage fences) keeps running; the 8d client just
  does not call what it does not know. All routes the 8d client calls exist
  on the current Worker with additive request/response fields only.

## What does not come back

The current surface's new functions while the fallback is deployed: the
Verlauf with ratings in the rows (HUI), the import selection page, import
deletion, playlist counts. Their data stays and is used again after switching
forward. This is not a full rollback to 8d, and the HUI option switched off is
not one either.

## Evidence (fallback root)

- `test/fallback/compat.test.ts`, `test/fallback/compat-controller.test.ts`:
  the fallback client's import protocol, the unchanged 8d protocol as a
  control, selection off/rules through fallback and back, later ratings
  -1/0/+1, duplicates, undo, stale and pushed-out receipts, a second
  listener, the current Verlauf controller's sign-out fence.
- The fallback root's `tests/`: the 5 original cross-version probes
  retargeted to this backend (and, as a control, to the real 8d backend), and
  a real local workerd run of the built artifacts across b201 → fallback →
  b201 on one persisted state.
