# PR30 independent atomic publication/cache rollback review

INDEPENDENCE = FRESH. Separate read-only reviewer, no implementation participation. Subject `a858098dc278492870ad04699e9d5c33cb1c43a0`; actual inspected functional backend delta from `6408961aecaf9c4717077a4499b8aa750256bb0e`. Clean detached checkout `/workspace/pr30-backend-a858`; canonical application target remains `8d62138184be9397ea22d55170928a4edbbc0725`. Guidance, current Handoff Map, Mika Verification and Red Team contracts used as navigation and independently checked against actual source.

VERDICT = READY narrowly for inspected backend atomic publication repairs. Full release remains BLOCKED outside this scope by inherited PR24–29 findings, missing full-scope completion and unavailable authenticated Cloudflare access. Independent UI and coordinator comprehensive gates remain separate.

## Actual implementation and contract

The new importTransaction wraps publication mutations in SqlDb.transaction and invalidates import/count/listen/artist/live/station caches on exception. Production adapter delegates to DurableObjectStorage.transactionSync. It now includes legacy summary+counter+genre invalidation, and final individual-listen page+metadata switch+old generation cleanup+counter+invalidation in one transaction. Existing totals promotion, apply and delete now use the same exception cache invalidation helper. No provider, queue transport, auth, bindings, migration or scheduler changes in this backend delta.

Direct tests establish:
- Summary failure after summary write but before history_commit leaves no stored summary, unchanged commit/view/memory; restart reads old state; retry stores once and repeated summary does not advance the counter.
- Final listens failure during upload cleanup, at the counter or after counter during deck invalidation leaves old stored generation, staged upload and pages intact. Retry of the same exact block succeeds once; duplicates are refused; restart retains result. Warmed selection/profile/memory reads return the prior state after failure.
- Apply and deletion failures at/after the counter restore published metadata, pages, counter, view and warmed reads. Retry succeeds once; duplicate/no-op handling leaves the counter stable. Local real DO probes test the actual exclusive() catch and transactionSync, not just nodeSQLite rollback.
- Existing protected tests preserve saved queue/live history/thumbs/bans/hearts/stations/discoveries, listener isolation and additive restore; tests added to the feature suite retain prior functional assertions. Source delta does not alter guest/native/device/429/projection behavior.

## Totals staging boundary (observed; no material defect confirmed)

The final totals block is appended to hist_stage BEFORE the publication transaction (preexisting behavior). A publication fault therefore retains that unpublished block while preserving old published totals/counter/read caches. An exact retry appends the same rows once more and promotes3 physical pages where2 would suffice; rawHist's per-track Map produces correct totals (3 and7 plays for the two songs) and the stored commit advances exactly once. The retained stage cursor accepts the exact retry after restart, and the completed upload rejects further duplicate continuations.

I initially tested the stronger requirement that ALL tables, including unpublished staging, remain byte-identical and that promoted pages contain no duplicate chunk. Those two assertions failed. Actual nodeSQLite and local DO runs confirm the boundary above. The final independent publication contract checks correct visible/published totals, commit, caches, restart and exactly-once promotion; it does not claim totals staging byte identity or page-level deduplication. No user-visible data/queue corruption, incorrect total, cross-tenant effect or required release defect was established by this artifact. It is documented rather than turned into a style/claim-only blocker.

## Direct executed evidence

1. Independent and existing scoped suites:
`npx vitest run test/hub/pr30-independent-atomic.test.ts test/hub/history-selection.test.ts test/hub/review-blockers.test.ts test/hub/session.test.ts test/hub/selection-ranking.test.ts`
**73/73 PASS**,5 files,3.42s,default timeouts. `/tmp/pr30-a858-backend.log`. Five own expected-contract probes include profile/listens/apply/delete fault+restart+retry and totals published-state retry. Reusable final probe `/tmp/pr30-a858-independent-atomic.test.ts`.
2. Same unmodified final independent probes against separate clean640 baseline: **2 FAIL (summary/listens),3 PASS**,1.05s. `/tmp/pr30-a858-independent-baseline640.log`. Failures directly reproduce previously non-atomic persisted mutations, demonstrating repair sensitivity.
3. **8 actual local workerd/SQLite Durable Object fault scenarios PASS for published-state invariants**, using real candidate UserHub, its private HubCore/SQL adapter, exclusive catch and transactionSync. Five inspected author fixture cases were retargeted to this Linux candidate and run by an independent assertion runner; additionally own totals/apply/delete cases were added. Profile counter/after-profile and events mid-cleanup/counter/after-counter preserve every stored row. Apply/delete post-counter also preserve every stored row. Totals has the staging exception above. All fault responses500; each reopen/retry/duplicate/reopen preserves the stated publication and counter invariants.
  - Harness `/tmp/pr30-a858-do/worker.ts`, config `/tmp/pr30-a858-do/wrangler.json`, own runner `/tmp/pr30-a858-do/check.py`.
  - `/tmp/pr30-a858-do-check.log`, `/tmp/pr30-a858-do/results.json` (6 cases), `/tmp/pr30-a858-do/extra-results.json` (2 extra cases).
  - Runtime logs `/tmp/pr30-a858-do-runtime.log`, `/tmp/pr30-a858-do-extra-runtime.log`; isolated local persistence `/tmp/pr30-a858-do/persist`, ports19590/19591. Local runtime stopped after checks.
4. Original overbroad staging/dedup assertions and failed logs retained: `/tmp/pr30-a858-independent-atomic-original.test.ts`, `/tmp/pr30-a858-independent-atomic.log`, `/tmp/pr30-a858-independent-atomic-retry.log`. These failures are explained above and are not presented as passing full-table totals atomicity.

All tests use synthetic data. Node tests use real HubCore/nodeSQLite/FakeSpotify; DO probes use actual local workerd Durable Object SQLite with one-shot synthetic adapter write faults. DO harness subclasses UserHub and intentionally bypasses standard auth/session HTTP routing to inspect transactional state; this is a local storage/runtime probe, not production auth acceptance or live Spotify use.

## Findings, limits, cleanup

Scoped new blocking findings: **[]**. Summary/final-listens atomic commit repairs verified at exacta858. No new incidental functional repair was implemented by reviewer.

NOT_RUN: physical iPhone, real owner export/provider transport/latency/quota, private HA/MA, populated production restore, production authenticated runtime/binding/secret/version/traffic/deployment checks. Real DO eviction/process crash was not forced: 'restart' explicitly reconstructs HubCore over the same actual persisted SQLite storage; this must not be labelled full process-loss restoration. Counter and state persistence plus transaction rollback are established in that bounded environment. Browser/UI/error ordering is reviewed separately.

Tracked application unchanged; temporary test files removed from candidate and baseline worktrees; dependency symlink is the only untracked item. No external comments, commits, merges or deployments.
