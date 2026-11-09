# Fresh independent backend review of integrated 1.3.2 / PR39 fixes

- SUBJECT: **c70e309a2893891d918bd061e3165a4d19071d90**, actual integrated/deployed source. PR39 head **a4a06d4fb5cc3b88692e45e3b95ff88df9f48f85**; new code commits245ce3e and e20f80c after previously reviewed39edfed, followed by documentation-onlya4a06d4. Actual author Mika Hertler, commits co-authored Claude Opus5.5, GitHub provenance MikaMcFlurry. No separate Claude login inferred.
- INDEPENDENCE = **FRESH**. Separate reviewer context, isolated clone `/workspace/true-shuffle-backend-review-132b`, exact detached subject, same-lockfile dependencies from previous checkout. Read AGENTS, MISSION/NNs, Red Team skill/independent-review contract, actual diff/source/tests. Builder completion and reports are leads, not proof.
- VERDICT = **BLOCKED**. A remaining P1 playback-ownership boundary and a P2 explicit unknown-429 Likes recovery deadlock. No app fixes, remote write, merge, deploy or rollback by reviewer. Root owns full gates/live identity and rollout decision.

## Repairs reproduced; original strict assertions retained

`vitest run test/hub/review132b-prior.test.ts test/hub/review132b-original.test.ts test/hub/continue-after.test.ts test/hub/likes.test.ts test/worker/storage-limit.test.ts test/worker/storage-limit-userhub.test.ts`

**85/85 PASS**,6files,36.20s. Includes all **17 unchanged prior strict probes** (8PR38 +9PR39): final-second manual choice, paused rewind/next-at0, acknowledged/ambiguous Likes retry, same-length external edit, SQLITE_FULL classification. The earlier exact manual-choice and1800/1900-entry false-success repros are repaired. Current conservative behavior retains genuine positive paused-at-end continuation; other-song/autoplay/crossfade/paused0/no-player cancel without play. Deliberate positive-test behavior changes were inspected, not accepted merely because tests turned green.

Evidence `backend-original-and-existing.log`; unchanged executable originals archived as `backend-prior-unchanged.test.ts.txt` and `backend-original-unchanged.test.ts.txt` (place in test/hub).

## B9341-02 / R132B-DUE — P1 blocking: newer observed unrelated playback cannot revoke due continuation

Affected `src/worker/hub/hub.ts:5008–5010` and5089–5097, alarm9755 onward. `noteContinueAfter` returns before inspecting any new observation when `c.due` is true; `runContinueAfter` then calls play without checking that newer observation.

Actual HubCore + SQLite + SpotifyClient/FakeSpotify, public methods and ordinary alarm:

1. Save/play a TS session; observe outside songB at60s; arm public `continueAfter(B)`.
2. Let B reach its actual duration; provider now shows B stopped at its exact end. A forced public `sync` observes that legitimate positive state. `state().continueAfter.due === true`.
3. Before the next alarm, listener starts different outside songC. A second forced `sync` **already records C**: `observed.track.id === C`, `state === playing`, outside attribution. The probe advances100ms between these observations; it does not rely on equal timestamps or unobserved provider action.
4. Let ordinary alarms run5s. Strict no-play assertion **FAILS**: one `PUT /v1/me/player/play`, C is cut to TS track1, result `ok:true`.

This is not the unobservable exact-end manual pause limitation. The Hub has a **newer observed incompatible user choice** before executing the automatic command. NN05 and the owner's no-commandeering/stable observed-state requirement apply. Expected: newer conflicting track/device/session/occurrence observations cancel or invalidate the due intent; execution must validate the observation/intent fence before writing. Keep positive observed-end continuation when nothing superseded it, but never let a due flag bypass newer facts.

Required strict regressions: paused-end due→new observed outside song, due→new observed manual pause/no-player/device/session change, foreground sync before alarm, restart between due and newer observation, and positive-end control with zero conflicting observations. Preserve current17 strict prior probes.

**Baseline control:** identical public-sequence probe on clean deployed1.3.1 source2c6118f also fails with one PUTplay. This is a pre-existing remaining boundary of B9341-02, not a newly introduced regression or a duplicate unchanged old repro. Narrower earlier probes now pass; this different state transition disproves the current categorical ownership claim.

Evidence authoritative final `backend-cooldown-and-due-probes.log` R132B-DUE and `backend-boundary-baseline.log`. Final executable `backend-new-boundaries.test.ts.txt`.

## R132B-LIKES-UNKNOWN-RETRY — P2 blocking: explicit retry cannot recover a no-Retry-After append hold

Affected HubCore1483 (`runJobs` creates client with `allowUnknownRetry=false`),1522–1535 (unknown429 parks job at MAX_SAFE_INTEGER),5202–5221 (`retryLikesSync` resets/requeues with no owner-initiated unknown-operation retry intent); SpotifyClient guard235–249; actual button `src/client/components/likes.tsx:27–40`.

Repro1700 exact ordered Likes, actual public retry and ordinary alarms:

1. Acknowledged900 entries; next POST playlist/items returns a single actual429 **without Retry-After**. Fake provider is configured to succeed on all subsequent requests.
2. User invokes actual `retryLikesSync` used by **Erneut abgleichen**. The first allowed PUT replaces contents with100 entries. The following POST is blocked locally because it is an unknown-reset cooldown on that exact operation and background jobs set `allowUnknownRetry=false`. No outbound POST probe occurs; job is parked at9007199254740991.
3. Let five minutes pass, restart the Hub, press retry twice again and run ordinary alarms. Every explicit attempt can replace those100 again but still never sends a POST to test recovery. Final actual100entries for1700 desired Likes. State remains honestly `pending:true,error:"Spotify hat diese Anfrage vorübergehend gesperrt"`; **this is not false-success**.

The finding is **the missing bounded explicit recovery route**, not that a normal multi-step replace is temporarily partial, not hypothetical dailyquota, and not an instruction to ignore an actual cooldown. `retryQuota`/availability trial only expose GETdevices/player/history/artist-albums; the operation-details UI has no playlistPOST retry action. Likes' own visible retry gives no owner-initiated unknown-operation probe; waiting/restart/repeated button presses do not recover it. Successful provider recovery remains unobserved because the app never requests it. NN09 requires truthful unknown-state handling and bounded explicit retry, while the Likes feature claims a failed write can be sent again.

Expected: offer a bounded deliberate retry of that unknown-reset POST when explicitly requested (preserving known Retry-After deadlines), then resume/rebuild exact ordered Likes; if the app intentionally cannot retry this operation, expose that limitation/action honestly instead of a non-working retry loop that keeps replacing partial contents. No automatic polling/stress and no clearing inferred provider holds. Regression should assert one bounded explicit operation attempt, exact eventual contents once provider accepts, persistent honest failure when it still refuses, no background retry storm, and known-deadline preservation across repeat presses/Like changes/restart.

**Baseline control:** identical recovery test on clean2c6118f also cannot recover, retains900 entries and sends no outbound POST; current version additionally truncates to100 because explicit retries now reset job/progress to a replacing first batch. Thus **pre-existing recovery deadlock, newly more destructive partial rewrite**, not a claim that this PR introduced the initial unknown429 hold. The author explicitly lists the100-entry limitation, but no owner exception waives this core recovery contract.

Evidence `backend-cooldown-and-due-probes.log` R132B-UNKNOWN and `backend-boundary-baseline.log`. Same final executable probe.

## Confirmed endpoint cooldowns: PASS; avoid a false broad-gate finding

Own independent probes for both **PUT** and **POST** playlist/items: inject actual429 with Retry-After120s; press retry repeatedly and change a Like during the wait. Assert no matching operation transport before the deadline; after expiry exact1701 ordered entries are stored. **2/2 PASS**.

A POST-held sync may issue a distinct PUT replacing the first batch. That does **not** prove a POST cooldown bypass: methods are independently confirmed operations. Matching endpoint/method transport remained blocked, and both cases eventually recovered exactly. The release-note suggestion that a Like change can shorten confirmed wait was not reproduced as an actual matching-operation violation. Do not report that builder speculation as established defect.

## Final probe accounting and limitations

- Existing/prior suite:85PASS.
- New final suite `vitest run test/hub/review132b-new.test.ts`: **4tests,2PASS/2FAIL** (confirmedPUT/POST pass; newer-observed due takeover and unknown429 explicit recovery fail).
- Baseline2c6118f samefile filtered to R132B-UNKNOWN/R132B-DUE: **2FAIL/2SKIP**; both remaining defects predate current fixes, exact earlier17 probes repaired.
- `backend-due-probe.log` earlier exploratory run first referenced nonexistent `observed.trackId` instead of actual `observed.track.id`; that fixture assertion was corrected before accepted final run. Final combined log asserts actual new observed C. Earlier logs retained, not positive defect proof. No application changes.
- Physical iPhone/Safari/PWA, real Spotify end behavior/latency/quota/crossfade/5xx, privateHA/MA and populated production restore/rollback-forward **NOT_RUN**. Synthetic probes are not real-provider latency/frequency/acceptance. Historical architecture packet09d772e remains navigation only. No live outage or rollback necessity established by these synthetic probes.
