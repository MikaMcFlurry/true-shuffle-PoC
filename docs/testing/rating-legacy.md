# Rating reads without a write number (legacy compatibility)

Test file: `test/client/rating-legacy/read-compat.test.ts` (helpers in
`fixtures.ts` next to it). Added by TS-RATING-LEGACY-261017 on top of R6
(`aa017dc8`). Tests only: `store.ts`, `history-ratings.ts` and the rating
model are unchanged.

## What is tested

The real store and the real Verlauf ratings, one account, two songs (X, Y).
Snapshot and Verlauf answers are synthetic and handed in by hand; the API
module is mocked, nothing reaches a network. Fake timers fix the clock, so
"one millisecond" and "ordered milliseconds" are both exercised.

The oracle is the store's own rule: a song's rating is shown alike
everywhere. For the song X the open sheet (`store.thumbOf(store.rating)`) and
its Verlauf row (`shown(row).value`, with the row the Verlauf last listed)
must agree. Controls pin the exact value where the source of truth is clear
(a write number, or a thumb given after the read was asked).

| Case | Situation | Expectation |
| --- | --- | --- |
| L1 (A6) | thumb +1 here, follow page asked after it lists −1 without `rated` | sheet = Verlauf |
| L2 ×3 | same on the first page; sheet opened before the ask / between ask and answer / after the answer | sheet = Verlauf |
| L3 | known −1 at write 6, later snapshot and pages say +1 without `rated` | both −1 (control) |
| L4 | known −1 at write 6, thumb +1 here, follow page −1 without `rated` | both +1 (control) |
| L5 | as L1 but `rated: 0` | both −1 (control) |
| L6 ×4 | thumb +1 given after the ask; one/ordered ms; first/follow page | both +1, thumb kept (control) |
| L7 ×2 | thumb +1 here, then a snapshot −1 without `rated`; one/ordered ms | sheet = Verlauf |
| L8 ×2 | after the L1 state, a younger numbered first page or snapshot (−1 at 8) | both −1, thumb gone (control) |
| L9 | follow page without `rated` lists only Y | X unchanged on +1 (control) |

## Status at R6

Red (open product counter-evidence, not marked as skip or expected failure):

- **L1 (A6)**: sheet +1, Verlauf −1. A row without `rated` is ignored by the
  store (`noteStored` returns early) but taken by the Verlauf (`noteListed`
  stores it as write 0 with the thumb as `seen`), so the Verlauf hides the
  thumb while the sheet keeps showing it.
- **L2, opened between ask and answer**: sheet +1, Verlauf −1. The first page
  lets the thumb give way and the sheet keeps it (`keepShown`); a list asked
  before opening does not retell the sheet.
- **L2, opened after the answer**: sheet 0 (the older snapshot's queue row),
  Verlauf −1. Nothing without a write number reaches `stored`.
- **L7, ordered milliseconds**: sheet −1 (retold by the snapshot), Verlauf 0
  (its last list). A snapshot without `rated` never reaches the Verlauf.

All four share one cause: an answer without a write number feeds only one
surface. Whether the sheet's "what it was opened with stands" rule should
win over agreement for reads asked before opening (L2) is a product
decision; until it is made the agreement oracle stays and these stay red.

Green: L2 opened before the ask, L3–L6, L7 in one millisecond, L8, L9.

## Running

```
npx vitest run test/client/rating-legacy/read-compat.test.ts
```

The run exits 1 while the red cases above are open.
