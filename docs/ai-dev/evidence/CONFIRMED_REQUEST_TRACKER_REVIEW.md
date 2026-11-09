# Independent confirmed-request tracker final review

Verdict: **READY**, bounded local policy/tracker change only. Independence: **FRESH**. Open findings: **none**.

Subject: frozen working application/test bytes against `516dea17fda6aaa2410ab3765bc25e70287a3f54`, exactly identified by the SHA-256 manifest below. Reviewer implemented no application repairs and used only synthetic providers. The final source hashes match the isolated snapshot used for tests. This review supersedes [the historical NOT_READY review](CONFIRMED_REQUEST_TRACKER_PRE_REPAIR.md); historical failure logs remain evidence of issues subsequently repaired.

## Verified contract

Only an actual429 records a hold for the affected listener plus uppercase HTTP method and normalized endpoint. A known future provider Retry-After blocks only that operation. Another operation/method/listener remains untested and may attempt its own real request; shared usage counts do not infer gates. Policy version2 archives previous local blanket/global/quarantine metadata and ignores it for new request decisions, preserving identity, history, saved session and checkpoint state. Old Registry gates remain historical storage rather than active policy inputs.

Unknown deadlines do not invent a release time. A fresh explicit invocation may attempt the operation; same-invocation and background retries are suppressed. Unknown background jobs are paused, with bounded maintenance alarm timestamps; a stale success cannot wake jobs paused by a newer hold. Known waits retain normal deadline enforcement. Request-local revision/generation fences protect success against newer429, including token exchange and refresh; metrics retain actual transport start times.

The aggregate SQLite tracker retains720 hourly slots, five stable anonymous listener mappings, overflow totals and a separate pre-login bucket. It retains at most200 episodes. Episodes correlate privately by actor+operation, independently of public aggregate labels. Raw actor/listener IDs, OAuth state/code, tokens and song/history content are excluded from the public report. Reads, writes, token refresh, actual429, network attempts and local blocks remain distinct. The startedAt of a successful transport must follow the latest failure before it can close that actor's episode; response arrival alone is insufficient. A first observed success is evidence for that attempt, not an exact Spotify reset, permanent release, unrelated endpoint capacity or developer-account quota allowance.

GET `/api/spotify/usage` passes the shared authenticated API middleware and UserHub epoch/session enforcement; its body reads Registry aggregates without Spotify HTTP. Current browser coverage includes unauthenticated401. Actual owner account readback remains unverified.

## Closed findings — independently rechecked

- **RT-T01, P2, blocking, CLOSED:** unrelated overflow/pre-login actor success formerly closed a shared-slot episode. The final actual Tracker/SQLite tests separate overflow listeners and distinct sign-in flow actors, permit only the matching actor's subsequent success, exclude private keys publicly, and prevent old uncorrelated `actor NULL` rows from claiming recovery during additive migration. The legacy undifferentiated `@signin` aggregate cannot establish recovery.
- **RT-T02, P2, blocking, CLOSED:** a delayed earlier200 formerly adopted a later shared revision and cleared newer429 after a blocked same-client request. The exact independent delayed200/new429/blocked-guard attack now preserves the newer hold. A separate episode test confirms earlier transport start cannot close a newer failure.
- **RT-T03, P2, blocking, CLOSED:** shared `@signin` operation holds formerly suppressed unrelated OAuth flows. The independent test extracts and executes the actual final `index.ts` policy: hashed flow A token429 does not suppress flow B token200, while flow A's known deadline remains enforced. Both flow actors retain public label Anmeldung and use no numbered account slot; unrelated success does not close A's episode. Synthetic codes/tokens/private flow values are absent from the public report.
- **RT-T04, P3, non-blocking, CLOSED:** lowercase `get` formerly bypassed the uppercase GET operation hold. The final request entry uppercases the method once; the same independent lower-case GET attack is now locally blocked with no additional HTTP.

## Final evidence

**64 tests PASS, ten files, 2.98 seconds**, including **11 reviewer-authored attacks**. Capacity/privacy/retention checks independently exercise seven listeners, 730 hourly observations retaining720 buckets, 210 episodes retaining200 rows, exact listener/method isolation, and stale CAS. Existing focused tests also cover independent availability GETs, one-refresh budgets, current holds, queue/history continuity and unknown background retry behavior.

**Six executions of actual transpiled UI components PASS:** future, expired, boundary and unknown operation deadlines; pending and recovered shared tracker episodes. Known deadlines disable only the affected recheck; unknown/expired values permit explicit recheck. The UI retains untested-control status, labels Retry-After as a saved value rather than a countdown, separates local/token/network accounting, qualifies partial hourly coverage, and states that other apps' usage and exact reset times are unavailable.

[Final tests](CONFIRMED_REQUEST_TRACKER_FINAL_TESTS.log), [actual component renders](CONFIRMED_REQUEST_TRACKER_FINAL_RENDER.log), [source hashes](CONFIRMED_REQUEST_TRACKER_SOURCE_HASHES.json). Portable reviewer attack sources are saved beside this report as `.test.ts.txt`; copy them into `test/spotify/` in an isolated checkout to run Vitest. The OAuth test executes the actual callback policy extracted from that checkout. The render harness is saved as `.mjs.txt`; adjust its absolute source path for another workspace.

Parent separately reports **357 integrated tests across24 files, 20 browser cases, typecheck, lint and build PASS** before the narrow migration amendment below. The integrated358-test rerun on the amended source is pending at this report update; it must pass and bind the same application bytes before activation. Those comprehensive results are builder evidence, distinct from the independently reproduced final run.

## Narrow migration amendment — independently rechecked

The once-only policy activation now admits jobs postponed by the exact old local-guard message `Spotify wartet auf die Freigabe weiterer Anfragen`. Its SQL changes only those rows' run_after to MIN(saved_time, now), clears that local error and updates the timestamp. Genuine provider-error schedules and normal future jobs retain their times. Job state, priority and attempts, histories, queues and player snapshots are not rewritten. Activation performs no Spotify HTTP. The policy-version marker prevents repeat admission; this applies to the first policy2 migration, consistent with the parent reporting the prior reviewed source uploaded but not activated.

The new focused regression initially failed before exercising migration because it used the wrong kv column name. Parent corrected key to k; the fresh complete64-test run now passes the actual migration and its one-time boundary. The original six UI component renders remain valid: their exact source hash is unchanged. Only Hub implementation and the added quota regression changed from the preceding review; all other manifest hashes were independently compared and remain identical. No new bounded finding remains.

## Limits and remaining live acceptance

Full mission acceptance remains **BLOCKED**. **NOT_RUN by this reviewer:** real owner authenticated tracker/operation readback, actual owner/provider recovery, owner playback writes, HA/MA recovery, other apps' developer-account usage, exact Spotify bucket allowance/reset time, sustained three/five-user capacity, fresh deployment acceptance for these source bytes, and actual populated-storage restore. No real Spotify or playback requests were made. The tracker is new partial observation, not historical full-day coverage, measured demand reduction, or proof that quota is resolved.

## SHA-256 subject binding

| Path | SHA-256 |
|---|---|
| `src/worker/spotify/client.ts` | `5a656b43eea5fd99bfa08f9368274a0b200a1cdf2fb9686c86dcd7334077828f` |
| `src/worker/spotify/usage.ts` | `6aa573588e901e987a3c2234d798689863d2f01f9fda4d71db563835610dddd1` |
| `src/worker/spotify/operation-gates.ts` | `e7917e4c7239ad93e97240cf9ae79fdcc09d3092836c997e69fb5a06101b5c39` |
| `src/worker/hub/hub.ts` | `a1f9d479d9a6eab1d10fafa0fe9a0bb0aa9fbfba71595f25ba747fcfde28369d` |
| `src/worker/registry.ts` | `65da4c66f0037b5b674ca41af28fac17fad295c92e9ecafd7b608813e30fecac` |
| `src/worker/userhub.ts` | `8c7b45955aaaedc2fec101ab7dcfb4ac9d4c3a71f29c9dd8deaee24b37dd5ca3` |
| `src/worker/index.ts` | `5c5852940dc30b132167e5a4fc153a25a2878c3f399d581d885d2e940bc372bd` |
| `src/shared/spotify-usage.ts` | `850a7e4aa5b7e7ff59c87f66a65a320ffcdc449826fa2a0d9e4319af3aacaa8c` |
| `src/client/api.ts` | `954d87add42538c96d392ecda151014c2aab86b1e9242f4480b942fef3d67a03` |
| `src/client/components/spotify-availability.tsx` | `49e670d19808af7a5a7828d134fe685adae47edc98e456347051307948e33286` |
| `src/client/screens/menu.tsx` | `c949e1607c17986f69b5bd132f5ebbc1c35ca07db5f10a5e3001b4a87cc6cc02` |
| `test/spotify/client.test.ts` | `3117589d91a95f4359e669bb66f2deb4114c5747fda306bbc323a6226288b84d` |
| `test/spotify/usage.test.ts` | `b075a1413a2465f47d84dcbf715b5dd8b89416d68d4f063131abfabca48dc637` |
| `test/spotify/availability.test.ts` | `51ee7aedbb15438e8ff7b7fbd8b23515f41b3272d739d57cedf6420cc81391ff` |
| `test/spotify/operation-fixture.ts` | `7356e0e04a2f518f074679a56b1c0e2f835e2a706d98acbc833a15360dbd14d4` |
| `e2e/app.spec.ts` | `85a1aef823350316d769be296e234c7c33249c0b47a5af132509a8c8aa80a23a` |
| `test/hub/quota.test.ts` | `099dde6a6d1f98ce60c31f0ae8e41d607fca572151efecc2464eeffb56609e5a` |
