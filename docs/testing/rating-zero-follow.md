# A confirmed `rated: 0`, then a follow page without `rated`

Test file: `test/client/rating-legacy/zero-follow.test.ts` (imports the
existing `fixtures.ts` next to it). Added by TS-HISTORY-ZERO-FOLLOW-TEST-261017
on top of `e9c10d88` (TS-HISTORY-LEGACY-SEEN-COR1). Tests only: `store.ts`,
`history-ratings.ts`, the rating model and every existing test are unchanged.

## What is tested

Same setting as `rating-legacy.md`: the real store and the real Verlauf
ratings, one account, songs X and Y, the API mocked, fake timers. Signed in
by a snapshot (a sheet opened before the first snapshot would be closed by
the change of account), the sheet on X is opened before any Verlauf read,
then the first page (X 0, Y 0, no write numbers).

Steps per case: a thumb +1 given here (or none), a follow page X = −1 at a
write number (`rated: 0`, or `rated: 1` as control), then — asked separately,
one millisecond later — a follow page X = +1 without `rated`.

Every step records, for X: the sheet (`thumbOf(store.rating)`, with the
store's write number), the Verlauf row (`shown(row)`, value and write
number), the thumb given here (and whether it is still the same object `o`),
`covers(o, 0)` and `storedOf` (value, number, whether its `seen` is `o`). The
traces are in the JSON report under `meta.zeroFollowTrace`.

| Case | Kind | Situation | Pinned / asked |
| --- | --- | --- | --- |
| Z1 | characterization | thumb +1, page −1 `rated: 0`, page +1 without `rated` | full trace; ends sheet −1@0, Verlauf +1@0 |
| Z2 | characterization | as Z1, no thumb given here | full trace; ends sheet −1@0, Verlauf +1@0 |
| Z3 | characterization (control) | as Z1 with `rated: 1` | both −1@1 after both pages |
| Z4 ×2 | consistency | end state of Z1 / Z2 | sheet = Verlauf |

## Status at `e9c10d88`

The refutable hypothesis (sheet −1@0, Verlauf +1@0) holds: Z1–Z3 green.
Green here pins today's behaviour; it is not product conformity.

Red (open product counter-evidence, not marked as skip or expected failure):

- **Z4, with and without a thumb given here**: sheet −1, Verlauf +1, both at
  write number 0. The store keeps `-1@0` (a row without `rated` never reaches
  `noteStored`). The Verlauf's `noteListed` reads the missing number as 0
  (`r.rated ?? 0`) and takes it on a tie (`seq >= cur.seq`), so the later row
  +1 replaces the confirmed −1@0, with `seen` cleared. In `shown`, `storedOf`
  does not outrank it (`0 > 0` is false) and the thumb, covered from 0 on,
  does not show. The thumb plays no part: Z2 ends the same without it.
- With `rated: 1` (Z3) the row without a number (0) is older and changes
  nothing: the split is specific to a confirmed write number 0.

Which surface is right is a product decision; no precedence rule is added
here. Related: L5 in `read-compat.test.ts` (the same `rated: 0` page, without
the later page) stays green.

## Running

```
npx vitest run test/client/rating-legacy/zero-follow.test.ts
```

The run exits 1 while Z4 is open.
