# Independent backend review PR30

INDEPENDENCE = FRESH (separate read-only reviewer, not involved in implementation; inherited operational background treated as indexes, direct code and real-Hub reproductions below).
VERDICT = NOT_READY for changed backend scope. Release additionally gated by draft/missing explicit completion and inherited open findings tracked by coordinator; this report does not close them.
SUBJECT = a247910b596266c785c3d30e3f1d18c4465e9064
BASELINE = 8d62138184be9397ea22d55170928a4edbbc0725
Checkout = /workspace/pr30-review-oct13

Read AGENTS, CODEX_START, HANDOFF_MAP, HISTORY_SELECTION contract, mika-red-team skill and independent review contract. Read actual schema/API/UserHub/import-selection/Hub diffs. Canonical target docs contain historical deployment headers; they are not current rollout proof. Functional expansion is substantial and needs separate explicit product-scope review, not a presentation-only acceptance.

## PR30-IMPORT-GENERATION — P2 blocking: new totals select against older plays; stale event upload still finishes
Affected: src/worker/hub/hub.ts:6263 (totals promotion), :6288(datasetKey), :6309(computeSelection), :7566–7594(importListens binding).

Repro A (real HubCore/node SQLite/FakeSpotify; no external services):
1. Import same song totals2 and completed individual plays at 2024-03-01 and 2025-03-01 (both200000ms).
2. Deliberately replace totals with10 plays; interrupt/omit following plays upload (as a failed re-import or totals-only client can do).
3. Apply excluded calendar year2024, UTC.
Expected: no cross-import event evidence; replacement totals whose matching individual plays are unavailable must remain totals-only (10 plays unaffected by a period), or retain the previous complete import until new pair is available with an honest pending/error state.
Actual: old listens generation remains attached to new history_import ID, coverage says events; effective memory becomes1 play. Nine plays silently vanish based on events not belonging to that import.

Repro B:
1. Import totalsA; start listen-uploadA part0 tracks, explicitly binding importIdA.
2. Commit newer totalsB (new import ID).
3. Complete listen-uploadA part1 old rows, even explicitly sending importIdA again.
Expected409 and no old data promoted intoB.
Actual success; old upload remains in kv listens_upload and input.importId is checked only at part0, not retained in upload metadata or revalidated at final promotion.

Impact: core history selection/ranking/profile/genre can refer to a different import than the owner deliberately selected; documented re-import/race guarantees are false. Atomic per-part SQL is insufficient to preserve logical import identity.
Repair: bind stored listens generation and staged upload to totals identity; supersede old staged event uploads on totals replacement and revalidate every later block/final promotion. Acknowledge separately staged new totals/listens rather than treating old events as new. Preserve all protected live data/queue unchanged.
Regression evidence: two tabs, delayed final block, failed event upload, totals-only replacement, restart between parts, active saved queue, selected periods/artists, matching import replay, legacy imports. Tests should assert raw/effective/history/profile coherency and refusal without writes.

## PR30-DELETE-LATE-LISTENS — P2 blocking: legacy delayed upload recreates explicitly deleted history
Affected: src/worker/hub/hub.ts:6661(deleteImport), :7571–7577(importListens first block).

Repro:
1. Store totals; capture a legacy app's event-upload first block which has no importId (baseline clients omit it).
2. deleteImport(selectionView().dataset.key).
3. Submit delayed first tracks block without importId; complete its returned upload ID with the old two rows above.
Expected: deletion survives late old-client traffic; absent current history_import cannot authorize event upload. Nothing reappears until deliberate new totals import.
Actual: accepted and persisted; selectionView.dataset becomes hasImport:true, songs:0, rows:2, key:'-|g1'. Deleted imported plays reappear in timeline/profile. Only explicitly supplied importId is gated; no-importId path bypasses the check.

Impact: documented deletion/privacy/race guarantee violated by stale deployed client, not an invented attacker or loss of account isolation.
Repair: refuse legacy event starts when totals do not exist and fence deletion/import lifecycle, without silently reintroducing deleted evidence. Compatibility must preserve intentional new import through a fresh totals identity.
Regression: late legacy first block after delete, late named first block, deletion mid-upload, newer deliberate re-import, restart, profile/genre and account isolation.

## Independent checks and artifacts
- Existing changed-scope suites: `npx vitest run test/core/import-selection.test.ts test/hub/history-selection.test.ts test/hub/playlist-counts.test.ts test/hub/selection-ranking.test.ts`: PASS48/48, 4files,3.67s, default timeout. Log /tmp/pr30-backend-targeted.log.
- Separate expected-contract assertions: 3/3 FAIL, 857ms total/158ms tests, no load/timeouts. /tmp/pr30-independent-race.log.
- Exact reusable reproducer: /tmp/pr30-independent-race.test.ts. It was temporarily run as test/hub/pr30-independent-race.test.ts then removed; no app or committed test changes by reviewer.
- Additive schema step8 keeps DO classes/bindings/migrationv1; new routes use existing per-epoch session/exclusive wrappers; no inspected new cross-account path. Existing tests cover migration7→8 and queue/likes/bans isolation; those passed independently above.
- Playlist-count changed job uses existing SpotifyClient/request budget/endpoint wait handling and honest incomplete results; existing403/429/snapshot/job-giveup tests passed. No additional confirmed playlist finding in this scope.
- No fresh reproduction of inherited PR24–29 findings here; unchanged earlier blockers remain the coordinator's canonical review evidence.
- Physical iPhone, live Spotify/quota/latency, private HA/MA, populated production restore: NOT_RUN. No authenticated deployment, public source mapping or independent browser claims in this backend report. No external comments/merge/deploy by reviewer.
