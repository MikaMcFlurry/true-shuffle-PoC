# Fresh independent backend re-review: PR39 / 1.3.2

- SUBJECT: `39edfed25987525f03d4f94006b12e7e532ea563`; combined application diff from deployed `2c6118f69c7671ea9efe506377f28d5d0376737b`. PR39 is based on release/1.3.0 `8c5243b9376c68e4ac3ad0d0678a47e647c139c8` (PR37 documentation after 2c6118f); three product commits 1b8b4e5 → ef6c5a8 → 39edfed. Actual Git author Mika Hertler and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, GitHub provenance MikaMcFlurry. No separate Claude account inferred.
- INDEPENDENCE = **FRESH**. Separate reviewer context, no implementation role, isolated clone `/workspace/true-shuffle-backend-review-132`, detached exact subject. Read AGENTS, MISSION/NN requirements, actual source/test diffs, Mika Red Team skill/independent-review contract and selected correctness/recovery/reliability lenses. Builder evidence treated as untrusted leads.
- VERDICT = **BLOCKED**. Residual P1 playback ownership defect and new P2 Likes exact-content regression. No application repair, production write, merge, deployment or rollback by reviewer. Root owns comprehensive typecheck/lint/build/Unit/Worker/browser and live deployment verification.

## Reproduced repairs and retained functional assertions

Command: `node_modules/.bin/vitest run test/hub/review132-prior.test.ts test/hub/continue-after.test.ts test/hub/likes.test.ts test/worker/storage-limit.test.ts test/worker/storage-limit-userhub.test.ts`

**PASS 5 files / 59 tests, 35.43s**. Includes the eight unchanged strict PR38 probes: manual pause at d−2001/2000/1999/1000, manual selection d−5000/12000, ambiguous append plus same-length external edit, SQLITE_FULL not daily quota. Regular current tests cover deliberate conservative crossfade behavior, automatic natural completion, bounded repeated ambiguous writes, exact ordered recovery, and truthful storage errors through actual Worker helper and extracted UserHub method. Existing wrapper/allowlist/config were not changed in PR39. No weakened assertion is accepted merely because a product test is green.

Evidence: `backend-prior-and-current.log`; unchanged probe source `backend-prior.test.ts.txt` belongs in `test/hub/`.

The previous SQLITE_FULL classification blocker is repaired: it now yields `storage_full` with no daily-reset promise. No new material storage-classification defect was established in this scoped review. Broader provider wording and real production storage exhaustion are not simulated acceptance.

## B9341-02 residual — P1, blocking: ambiguous manual song choice or paused-at-zero still starts music

Affected `src/worker/hub/hub.ts:5057–5062,5086–5103`, constants `CONTINUE_AFTER_PICKED_MS` and `CONTINUE_AFTER_AT_START_MS`.

Actual HubCore + SQLite + SpotifyClient + FakeSpotify, ordinary alarms, synthetic account only:

1. Save/play a TS session; observe an outside 240s song at60s; arm `continueAfter` through the public method.
2. Manually start a different outside song at d−1000, d−999, d−500 or d−1; let ordinary alarms run60s.
3. Each strict no-play assertion **FAILS**: exactly one `PUT /v1/me/player/play` replaces manually selected outside track `...007` with TS track `...001`, result `ok:true`. Control at d−1001 **PASS**. The previous12s takeover window is reduced to1s, not eliminated.
4. Independently, five seconds before the outside song's end, manually pause and rewind the same song to0 (Spotify back/seek), or manually load another outside song and pause at0. With no intervening hub observation, run ordinary alarms60s. Both strict no-play assertions **FAIL**: one PUTplay, `isPlaying:true`, result `ok:true`.

Expected: observed manual stop and new unrelated listener selection remain untouched. Elapsed predicted end plus paused-at-zero/new-young-song is ambiguous, not positive provider evidence of natural completion. If the endpoint cannot distinguish user action from natural end, conservatively retain/cancel the intent or require explicit confirmation. Preserve natural completion cases supported by positive observations; do not bless takeover as an allowed assertion.

Impact: starts music after the listener stopped it, and cuts newly selected unrelated playback. NN-05 and the owner's explicit playback ownership requirement apply to all cases, not only5s/12s before end. PR39 documents these cases as known boundaries (pause/back-next P2 and final1s), but the user has not accepted that exception. A narrower timing window or pre-existing origin does not make the material trust violation non-blocking.

Required regressions: manual selection d−1001/1000/999/500/1 and after the boundary; paused same-song rewind0/different-song0, with and without an intervening observation; positive observed completion; pause/resume/seek, occurrence/device switch, no player, stale observations; zero unwanted playback calls throughout ambiguous cases. Current release text `src/shared/release.ts` claiming a manually selected song continues and pauses always stay silent overstates the actual behavior; repair that user-visible claim alongside behavior.

Direct evidence: `backend-adversarial.log`, R132-PICK and R132-PAUSED-REWIND; executable `backend-adversarial.test.ts.txt` in `test/hub/`.

## R132-LIKES-RETRY — P2, blocking, NEW regression: visible-error retry forgets progress but resumes old job offset

Affected `src/worker/hub/hub.ts:5235–5239` (`retryLikesSync`), existing enqueue conflict behavior1477–1490 and `stepLikesSync`5270 onward. Actual UI entry point `src/client/components/likes.tsx:27–40` offers `Erneut abgleichen` whenever `likes.sync.error` is present, including while pending automatic retry.

Reproduction uses1700 exact ordered Likes, normal public `retryLikesSync`, ordinary alarms, actual SQLite/provider client:

1. First step acknowledges800 songs; persisted jobs.state is `{rev:2,offset:800,remade:false}`.
2. Next step acknowledges800..899. Append900..999 returns502; test both response-lost-after-provider-acceptance and no-provider-acceptance. Durable progress is `{rev:2,pid,offset:900,sent:{from:900,to:1000},restarts:0}`. Public state visibly shows `Spotify-Fehler 502` while the scheduled job is pending.
3. Invoke the same public retry method used by the visible button, before automatic backoff completes. Finish ordinary alarms.
4. **No accepted failed batch**:1800 provider entries,1700 unique. **Accepted failed batch**:1900 provider entries,1700 unique. Both final public sync states falsely report `pending:false,count:1700,error:null`. Strict full ordered equality fails in both cases.

Cause supported by source and direct readback: new `kvDel("likes_sync_progress")` removes the precise acknowledged/ambiguous checkpoint. `enqueue` ON CONFLICT adjusts due/priority but keeps the existing job's offset800. Next step finds no durable progress and appends starting from800 onto900/1000 existing entries. This is a new PR39 regression, not merely a limitation of concurrent external edits.

**Baseline control:** identical two strict retry probes on an isolated clean deployed source `2c6118f` **PASS2/2**, 1.24s (`backend-retry-baseline.log`); exact PR39 head **FAIL2/2**. Previous progress retention prevents this duplication.

Expected: explicit retry after a shown error starts from a consistent state and eventually produces the exact ordered Likes or an honest unresolved/failure result. Repair must reset queued job state together with progress and replace from0, or preserve/interpret the existing checkpoint atomically. Do not discard one half of resumable state. Regression coverage must include explicit retry after a partial step + accepted/lost response and nonaccepted502, confirmed429/cooldown (without bypass), delayed automatic retry, retries during pending work, late responses and process restart. Preserve the bounded3-restart behavior and strict ordered equality. The current6h bounded retry test only presses retry after the failed job has been removed; that misses this visible-error path.

## Results and limits

Own final probe command: `node_modules/.bin/vitest run test/hub/review132-adversarial.test.ts` → **9 tests,1 PASS /8 FAIL**, exit1. Six playback-ownership failures and two new explicit-retry Likes failures. Failed assertions express required behavior; not patched to accept corruption/takeover. Raw log is authoritative. Baseline command: same file with `-t R132-LIKES-RETRY` at2c6118f →2PASS/7SKIP.

Physical iPhone/Safari/PWA, real Spotify latency/quota/crossfade/5xx response semantics, private HA/MA and populated production restore/rollback-forward are **NOT_RUN**. Synthetic elapsed durations are not measured live fault frequency/latency or provider acceptance. Current handoff architecture baseline09d772e is historical navigation and not fresh architecture acceptance. No live outage requiring rollback is established by these probes. No app or vendored skill change by reviewer; local additions are review tests plus symlinked same-lockfile dependencies only.
