# PR30 independent stored commit review

INDEPENDENCE = FRESH. Distinct read-only reviewer, no implementation participation. Separate clean detached worktree `/workspace/pr30-backend-640`; subject `6408961aecaf9c4717077a4499b8aa750256bb0e`; actual inspected backend delta from `898c4d8` (parent commit) plus retained prior continuation/dataset fences. Canonical target application remains `8d62138184be9397ea22d55170928a4edbbc0725`. Actual guidance and verification/red-team contracts read; stale historical headers were navigation aids, not current production proof.

VERDICT = READY narrowly for the inspected backend stored-commit delta. This is not full release acceptance: inherited PR24–29 blockers, missing release-scope completion and authenticated Cloudflare access remain; independent UI review and coordinator comprehensive checks are separate gates.

## Inspected contract

The additive `HistorySelectionView.commit` orders published import/selection states. `history_commit` is durable per-listener KV, defaults to0 for existing storage, increments through `importChanged` on totals/listens publication, selection changes and deletion. A first imported summary advances the counter because it changes `summaryProfile`; subsequent summary contents are not part of this selection view and intentionally do not advance it. This counter is separate from selection revision and import identity. Deletion response returns the actual post-delete counter.

- Totals/selection/deletion counter changes occur inside their existing SQL transactions. Independent injected failure after increment during totals promotion rolls back the counter and published totals together; after HubCore restart old dataset identity and2 plays remain.
- Individual listens counter advances only after the final validated block switches stored metadata; staging blocks do not advance it. Publication/restart tested directly. Existing sync/no-await UserHub exclusive/session serialization prevents two tab requests from sharing an increment. No schema, DO identity, binding, auth, runtime migration or scheduler change in this delta.
- Reads/preview, unchanged selections, wrong revision/dataset, wrong continuation id, missing/deleted imports and staged uploads do not create commit values. Tests independently reproduce exact counts under a frozen clock, so ordering is not wall-time based.
- Another listener's counter/import/revision stays unchanged by mutations to the first listener. First summary is stored only with existing totals; deletion prevents a delayed summary from reappearing and advances only the owner's counter.
- The counter describes published import/selection state, not every field in the response. `uploading` may change while the counter stays equal because the published import is unchanged; this is consistent with its source contract. No claim of durable operation receipts or provider acknowledgment is introduced.
- Existing functional assertions remain intact; new commit tests append to the history suite. Backend delta does not change queue occurrence/order, observed progress, live plays/private/guest/native behavior, hearts/thumbs/bans, endpoint429/device attempts or projection. Inspected and executed preserved suites exercise those history/selection preservation assertions and additive SQLite restoration; this is a scoped regression claim, not new live acceptance.

## Direct evidence

1. `npx vitest run test/hub/history-selection.test.ts test/hub/review-blockers.test.ts test/hub/session.test.ts test/hub/selection-ranking.test.ts`: **62/62 PASS**,4 files,12.59s,default timeouts. `/tmp/pr30-640-backend.log`.
2. Independent adversarial commit probes: **4/4 PASS**,2.87s,default timeout. `/tmp/pr30-640-independent-commit.test.ts`, `/tmp/pr30-640-independent-commit.log`. Includes frozen-clock staging/errors/no-op/two revisions/delete/reimport; listens publication/restart; injected transactional rollback; first summary/repetition/listener isolation/deletion.
3. Same unmodified probes against clean prior898 source: **4/4 FAIL**,1.52s, expected negative control because stored counter/response fields are absent. `/tmp/pr30-640-independent-baseline.log`. This demonstrates sensitivity to the added counter contract; rollback behavior itself was preexisting.

Tests use real HubCore/nodeSQLite with FakeSpotify and synthetic fixtures. Parent owns full static/build/unit/Worker/browser gates. Temporary tests removed after execution; exact source HEAD reread, only dependency symlink remains untracked. No edits to tracked application or external actions.

## Findings and limits

Scoped new findings: **[]**. No newly confirmed backend blocker at this exact head. Full release readiness remains blocked outside this narrow delta.

NOT_RUN by this reviewer: real owner export/Spotify transport, latency or quota; physical iPhone; private HA/MA; populated production restore; authenticated deployment/runtime/binding/secret/traffic verification; browser visual behavior and HTTP auth integration. Storage outage/crash between nontransactional legacy summary/listens writes was not separately fault-injected; normal operation/restart and explicit transactional rollback were tested. UserHub serialization and middleware remain unchanged and were inspected, not re-certified as production acceptance.
