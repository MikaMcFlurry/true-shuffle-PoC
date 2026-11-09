# Historical pre-repair review — superseded by final review

# Independent confirmed-request tracker review

Verdict: **NOT_READY**. Independence: **FRESH**. This is a bounded review of current working source, not approval of a final frozen release. Two blocking P2 findings remain; one non-blocking transport edge remains. No application repairs were made by the reviewer.

Subject: working changes against `35a98ef3ab8080d4668e030f8aba418fac6bffda`; exact SHA-256 hashes below. The quota implementer froze its client/Hub changes, while root-owned tracker/OAuth repairs and integrated validation remain pending. Parent agent is currently marked errored for model capacity; this report preserves concrete review results for its continuation rather than treating unavailable implementation work as completed.

## Open findings

### RT-T01 — P2, blocking: unrelated-user success closes aggregate episode

`SpotifyUsageTracker` keys pending episodes by public slot+operation. First five listeners have stable private mappings, but every later listener shares slot 6 and every pre-login activity shares slot 0. Reproduction: allocate slots1–5, record listener6 devices429, then listener7 devices200. The overflow episode receives firstSuccessAt despite listener6 having no successful request. A separate pre-login429 followed by a different flow's200 likewise closes an episode. Both independent actual Tracker/SQLite tests fail. This makes the requested same-user/operation recovery evidence false.

Repair: privately correlate episodes to the individual actor/flow without exposing identifiers, or omit uncorrelatable overflow/pre-login success attribution while retaining all aggregate counters. Regression: unrelated actor success cannot close the failed actor's episode; a real same-actor success may close it. No global allowance or exact provider-reset conclusion may be inferred.

### RT-T03 — P2, blocking: shared sign-in gate blocks unrelated OAuth flow

`index.ts` supplies the same `@signin` listener key to all operation snapshot/block/finish RPCs. An actual token429 in OAuth flow A therefore suppresses flow B's token exchange until A's deadline, contrary to the owner instruction against cross-user preblocking. Independent real `SpotifyClient.exchangeCode` plus actual Gate/SQLite with the exact index policy wiring reproduces one HTTP attempt total instead of two distinct-flow attempts. This test models the current callback policy; it does not exercise a real provider or live callback.

Repair: isolate confirmed operation holds by private OAuth flow identity, or avoid persistent cross-flow preblocking when listener identity is unavailable. Keep pre-login aggregate counts separate from operation-gate identity. Regression: flow A's confirmed token hold does not suppress unrelated flow B; legitimate same-flow deadline and stale-success behavior remain fenced. Retarget the test to the repaired actual policy; retaining its hard-coded old shared key would be historical evidence only.

### RT-T04 — P3, non-blocking: lowercase method bypasses normalized operation deadline

`request('get', '/me/player/devices')` sends GET through Fetch normalization but keys the gate/category with lowercase input. After confirmed uppercase devices429 Retry-After3600, this invocation sends HTTP successfully rather than respecting the existing operation hold. Independent test fails. Existing application call sites use uppercase, limiting current user-facing reach. Normalize the method once at transport entry and test both spelling variants against the same hold.

## Closed finding and verified boundaries

**RT-T02, P2, blocking, CLOSED:** an old devices200 used the shared revision Map after a third blocked request observed a newer429 revision, clearing the new hold. Before repair the independent concurrent transport test failed. Final quota-owned code captures request-local revision/generation for each transport, including refresh/exchange; the same independent delayed200→new429→blocked-guard attack now passes. No source-level conditional success reads the later shared Map revision as its original CAS fence.

**41 focused tests PASS, six files, 1.08 seconds**, on the quota freeze plus current tracker. This includes the repaired race and reviewer-authored capacity/privacy/retention checks: seven listeners produce five stable private mappings plus overflow counts; pre-login counts are distinct; reads, writes, token refresh, network failures and local blocks count separately; raw listener/playlist identifiers are absent from the public report; 730 simulated hourly observations retain720 buckets; 210 closed episodes retain200 rows; listener/method isolation and stale CAS preserve newer holds.

Source inspection confirms policy version2 archives old blanket/global/quarantine records locally, no longer consults them for requests, and preserves identity/history/session state. Actual429 gates are listener+method+normalized endpoint. Known future waits suppress only that operation. Unknown waits suppress background work and same-invocation loops, while explicit requests may attempt again. Unknown jobs are paused with bounded maintenance scheduling; stale success only wakes them after a matching local clear or observed shared null. Authenticated GET usage routing checks the existing session generation. These checks do not close RT-T01/03.

## Evidence and continuation

[Focused passing run](CONFIRMED_REQUEST_TRACKER_FOCUSED.log), [episode failures](CONFIRMED_REQUEST_TRACKER_EPISODE_FAILURE.log), [OAuth isolation failure](CONFIRMED_REQUEST_TRACKER_SIGNIN_FAILURE.log), [method failure and race closure](CONFIRMED_REQUEST_TRACKER_METHOD_FAILURE.log). Reviewer attack sources are saved beside this report as `.test.ts.txt`; copy them into `test/spotify/` of an isolated checkout to reproduce. All providers are synthetic. Parent must repair open blockers, signal a final source freeze, rerun appropriate integrated/static/browser checks, and obtain a fresh hash-bound closure review before publication/deployment.

**NOT_RUN:** final integrated/static/browser release validation for this changed policy/tracker, independent real-Worker authentication test for the new usage route, real owner tracker readback, owner/provider recovery, Spotify exact bucket limits/reset window, sustainable three/five-user usage, HA/MA recovery, and populated-storage restore. Full mission live acceptance remains **BLOCKED**. No real Spotify or playback requests were made by this reviewer, and no quota recovery/capacity claim follows from synthetic counts.

## SHA-256 subject binding

| Path | SHA-256 |
|---|---|
| `src/worker/spotify/client.ts` | `db3a1ba0d13c7b1ada97688f768fcb20b86e42a0e81f432fc6518759db35f301` |
| `src/worker/spotify/usage.ts` | `1d6fb787bf7abbe43a9ea79f78f190b05b87053a1c5d34c354a6824cd35cf151` |
| `src/worker/spotify/operation-gates.ts` | `367622c661f5d1daebbb4ceadc99ab20b8d729bdb9465c388b89ccc1188cd98e` |
| `src/worker/hub/hub.ts` | `1a99ba57f1303026abbf1f0a50149e2262e2602b11531acb1d8dbf0dd1e53425` |
| `src/worker/registry.ts` | `65da4c66f0037b5b674ca41af28fac17fad295c92e9ecafd7b608813e30fecac` |
| `src/worker/userhub.ts` | `8c7b45955aaaedc2fec101ab7dcfb4ac9d4c3a71f29c9dd8deaee24b37dd5ca3` |
| `src/worker/index.ts` | `9e9418d66d1edd30c5db77466adeed5aa21e5e86be432653e9bc4f19f8385bad` |
| `src/shared/spotify-usage.ts` | `850a7e4aa5b7e7ff59c87f66a65a320ffcdc449826fa2a0d9e4319af3aacaa8c` |
| `src/client/api.ts` | `954d87add42538c96d392ecda151014c2aab86b1e9242f4480b942fef3d67a03` |
| `src/client/components/spotify-availability.tsx` | `49e670d19808af7a5a7828d134fe685adae47edc98e456347051307948e33286` |
| `src/client/screens/menu.tsx` | `c949e1607c17986f69b5bd132f5ebbc1c35ca07db5f10a5e3001b4a87cc6cc02` |
| `test/spotify/client.test.ts` | `c417b747ea8f5c90c3602d7201fa3a5e1925784116db6eb982a8fdbf1e183214` |
| `test/spotify/availability.test.ts` | `51ee7aedbb15438e8ff7b7fbd8b23515f41b3272d739d57cedf6420cc81391ff` |
| `test/spotify/operation-fixture.ts` | `7356e0e04a2f518f074679a56b1c0e2f835e2a706d98acbc833a15360dbd14d4` |
| `e2e/app.spec.ts` | `4cb8261c822f6855b4e2d755bc53a4547ca9446690e9e24f16c4e0929de156f6` |
