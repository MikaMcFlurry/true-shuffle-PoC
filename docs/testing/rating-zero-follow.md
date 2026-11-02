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

## Contract since TS-HISTORY-ZERO-FOLLOW-COR1-261017

Everything above is kept as written for `8e06dd18`: it records the state the
fix starts from (Z1–Z3 green as characterization, Z4 red). The released
contract: a confirmed `rated: 0` (X = −1) is not replaced by a later row
without `rated` (X = +1). Sheet and Verlauf both stay −1@0, with and without a
thumb given here. A missing number is no confirmed 0.

Product change, only `src/client/history-ratings.ts` (`store.ts` unchanged):
every source of a Verlauf rating carries whether its number is a write number
the server gave (`numbered`); a row without one is still read as 0 (and sent
as `basis: 0`). One rule, `outranks`, orders sources: a higher number, or an
actual number against that 0. It is used where the list keeps the newest row
(`noteListed`), where a confirmation here meets the list, and where the
store's newest stored rating meets both (`known`). Positive numbers, an
explicit 0 against an explicit 0, rows without a number among themselves, the
account/generation fences, `seen`/`covers` and retry/undo are as before.

Test changes in `zero-follow.test.ts`:

| Case | Kind | Situation | Pinned |
| --- | --- | --- | --- |
| Z1, Z2 | contract (were characterization) | as before | last step Verlauf −1@0 (was +1@0); the rest of the trace unchanged |
| Z3 | control | unchanged bytes | both −1@1 |
| Z4 ×2 | contract | end state of Z1 / Z2 | sheet and Verlauf −1@0, `storedOf` −1@0 (seen = thumb or none), the thumb (+1) still standing, and the rendered row is the +1 without `rated`: the value is the confirmed write's |
| Z5 ×2 | contract | the confirmed 0 comes from a snapshot (no thumb; a thumb the snapshot settles), then a page +1 without `rated` | −1@0 after the snapshot and after the page |
| Z6 | contract | rows without `rated` only; a Verlauf rating begun on one and refused (409); then an explicit −1@0 | before: Verlauf +1@0, nothing stored; after: −1@0 (the 0 begun from a missing number does not hold against it) |
| Z9 | contract | another song: one page lists Y −1 and X +1, both without `rated` | Y −1@0, X −1@0 |
| Z7 ×2 | control | thumb 0 given here after the follow page was asked (same ms / 1 ms later) | sheet and Verlauf 0, stored −1@0, the new thumb not covered |
| Z8 ×2 | control | a numbered page X +1 `rated: 1` after the page without `rated` | both +1@1 |
| Z10 | control | another account signs in while a page is on its way | the late page is not taken; the new account starts from nothing |
| Z11 ×2 | control | the same write (explicit 0, positive 3) read again after a thumb +1 here | it accounts for the thumb: both −1@n |

Against the unchanged product file of `8e06dd18`, the identical test file has
8 red (Z1, Z2, Z4 ×2, Z5 ×2, Z6, Z9) and 8 green (Z3, Z7, Z8, Z10, Z11). With
the fix, 16 green.

Observed, not changed (outside this contract): with rows without `rated`
only (Z6, first step) a follow page does not retell an open sheet (only a
first page does), so the sheet keeps what it was opened with.

Rendered: `e2e/history-zero-follow.spec.ts` (real Verlauf with 60-row pages,
`startListRead`/`takeListed`, `ratingShown`; intercepted API answers):

- S: sheet open on Song B; first page confirms −1 `rated: 0`; "Ältere laden"
  asks the older page, Song B +1 without `rated`; sheet and both rows −1,
  also after closing the sheet. The modal sheet makes the page inert, so the
  click on "Ältere laden" is dispatched to the button.
- V: sheet closed, real clicks; both rows −1; the sheet opened afterwards −1.
- O: a thumb +1 from the sheet first (queue row shows it); first page without
  Song B, the older page −1 `rated: 0`, the oldest +1 without `rated`; both
  rows −1, queue row and sheet −1. The fixed page clock keeps the notice up
  over "Ältere laden", so that click is dispatched too.

Against the unchanged product file all three fail where the rows turn +1
("Favorit" pressed); `rate-sheet-shared-revision.spec.ts` (unchanged) passes
on both.

```
npx vitest run test/client/rating-legacy/zero-follow.test.ts
```

exits 0 with the fix.
