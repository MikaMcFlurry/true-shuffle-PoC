# Rating model replay (TS-RATING-MODEL-261016)

A model-based replay of the shared rating rule: the open sheet, the store
(`thumbOf`) and the Verlauf (`shown`) against an independent model, with
synthetic server answers. Test-only; no product, dependency or config change.

Files (`test/client/rating-model/`):

| file | role |
| --- | --- |
| `model.ts` | the independent model (from docs/HISTORY_RATINGS.md and the R5/R6 commit statements) and the eight contracts |
| `commands.ts` | commands, generator (fast-check, at most 25 commands), 100 fixed seeds |
| `adapter.ts` | the actual store + Verlauf adapter, and pure test adapters (correct, or with one fault each) |
| `replay.ts` | synthetic server (one account, three songs), held answers, model feed, per-step contract checks, normalised trace + sha256 |
| `model.test.ts` | **harness self-tests** — no product code |
| `conformance.test.ts` | **product conformance** — actual store and history modules |

## Scope

One account, three songs, no account change, no navigation (the Verlauf's first
page is asked for once, later pages one at a time). At most one snapshot on its
way (the store serialises refreshes); at most one Verlauf rate/undo per song.
Answers are held and given by command, so late answers, first and later pages,
same-millisecond decisions (the clock moves only on `tick`), confirmations and
undo interleave. No impossible revision pairs: every number comes from one
server; one write number always has one value. Not covered: lost answers
(timeouts, 5xx), receipt lookups returning nothing, retell of answers without
write numbers, account change, sign-out, skip behaviour, rendering.

## Model

- Newest stored rating per song = the highest write number heard from any
  accepted read (snapshot, any Verlauf page, taken confirmation/undo). Lower
  never replaces it; equal is the same write.
- A rating given here is a new decision (identity). It shows everywhere until a
  read accounts for it: a Verlauf page asked while exactly that decision stood,
  or a snapshot asked in a strictly later millisecond (`settleThumbs`' clock
  rule). Accounted for once, it gives way also to later writes heard without it.
- A confirmation/undo answer is taken when nothing was rated here since it was
  asked and its number is not below the newest known; otherwise the rating now
  (read at answer time) is taken. A taken value counts as accounted for at its
  number.

## Contracts

C1 NO_LOWER_REVISION · C2 HIGHEST_REVISION_VALUE · C3 LOCAL_DECISION_SHOWN ·
C4 OVERRIDE_IDENTITY · C5 SHEET_VERLAUF_AGREE · C6 FOLLOW_PAGE_COUNTS ·
C7 LATE_ANSWER_INERT · C8 EQUAL_REVISION_TIE (full text in `model.ts`). Every
step compares Verlauf value and number, `thumbOf` and the open sheet with the
model; a mismatch is attributed to the contract of its cause (an equal-number
answer → C8, a lower-number answer → C7, a later page → C6, …). The Verlauf's
rate request must carry the newest known number as `basis` (C1).

## Generator

Single commands mixed with four race fragments (random song, values, page
contents): decision / page asked while it stands / newer write / same-ms
snapshot; late snapshot after a page; Verlauf rating racing snapshots and
writes; decision / same-ms newer write / page at the same number. Fragments
are ordinary commands, checked and shrunk like any other; inapplicable
commands are recorded as skipped. Shrinking works on the fragment list.

## Named traces (TS-RATING-UNDO-EVIDENCE-R2)

The 100 seeds apply an undo once only, as their last command, without its
answer. Named deterministic traces close that gap and pin each contract to one
readable case; the same commands stand in both test files.

- **Contract cases C1–C8** (`CONTRACT_CASES`): one trace per contract. In
  `model.test.ts` each is green with the correct pure adapter and red under
  exactly its contract with one fault: the four pure-adapter faults for C4,
  C6, C7, C8 (their fixed traces) and four test-local wrappers for C1
  (frozen write number), C2 (stale value), C3 (dropped local rating) and C5
  (stale sheet). In `conformance.test.ts` the product runs each trace; every
  command must apply and the last observation and server state are fixed
  values.
- **Undo cases** (`UNDO_CASES`, Verlauf rating on A confirmed, sheet open on
  A, then undo): U1 undone, U2 conflict (a newer write elsewhere), U3 late
  (answered below a write a snapshot already heard; inert), U4 answered after
  a newer write not yet heard, U5 a rating given here meanwhile. Each applies
  the undo request and its answer and ends with a snapshot read. Checked: the
  op log (`rate`/`undo` asked and answered, outcome, late), the Verlauf
  value@write, store value and sheet right after the undo answer and after the
  read, as fixed values and against the model.
- **Counter-probe** (`conformance.test.ts`): the undo answer is withheld from
  the product (the request is still sent and stored). U1, U2, U4, U5 must turn
  red; U3 must stay green, as a late answer is inert by C7 and withholding it
  is not observable.

`replay()` also returns `ops`, the Verlauf rate/undo requests and answers;
it is kept beside the normalised trace, so trace bytes and hashes are as
before. Seed evidence files carry it.

## Running

```
npx vitest run test/client/rating-model/model.test.ts        # harness self-tests
npx vitest run test/client/rating-model/conformance.test.ts  # product conformance
```

`RATING_MODEL_EVIDENCE=<dir>` writes traces (per seed, with sha256 and, when
red, the shrunk counterexample) and mutant reports.

Self-tests and product conformance are separate statements: green self-tests
say the harness finds the four faults (lost seen, ignored later page, lower
write number taken, wrong tie) and passes a correct pure adapter; they say
nothing about the product. A red conformance seed is a product finding and
stays red: no skip, no expected failure, no weaker oracle.
