# Independent backend review

SUBJECT: `/workspace/true-shuffle-review-9341`, detached `9341e0d3305778210adbf89e165ec3f66459a956` (combined PR31/32), compared with `b2aac5bd85bc9be16fcf13fe51adf80025bb9d19`.

INDEPENDENCE = FRESH. This reviewer did not implement these changes. I read actual source, the checked-in tests, AGENTS.md, CODEX_START.md, MISSION.md, release 1.3.0 notes, and the Mika Red Team independent review contract. I designed and ran the adversarial probes below independently, using real HubCore/SpotifyClient and SQLite with FakeSpotify. Builder assertions and existing tests were navigation aids, not acceptance evidence. The inherited handoff map is historical (`09d772e...`) and does not identify this release; the explicit review subject above does.

VERDICT = BLOCKED (scoped backend review). There is one P1 and one blocking P2. This is not live Spotify, Cloudflare, browser, or complete release acceptance.

## B9341-01 — P2, blocking: resumed Likes sync duplicates successful appends after a transient failure

Affected source: `src/worker/hub/hub.ts:5213`–`5217`, `5242`–`5252`; job error/checkpoint behavior at `1472`–`1489`, `1500`–`1540`.

Preconditions: Likes span multiple steps (probe: 1,700 tracks). One continuation step has an acknowledged append, followed by an ordinary 500 or a 429 with Retry-After. This is new functionality, absent from the baseline.

Reproduce: run the preserved `backend-review.test.ts` in the isolated worktree (command below). The probe plants the exact persisted Likes schema with 1,700 valid fake catalog IDs, calls the public `retryLikesSync()`, and injects one failed POST when the target playlist has 900 items. Its first completed step holds 800 tracks; continuation appends 100 successfully and then receives the failure. It runs the normal alarm loop through recovery and asserts exact ordered equality to the Likes.

Expected: the playlist contains each of the 1,700 liked tracks exactly once, in order, and successful status agrees with its content.

Actual, reproduced separately for HTTP 500 and HTTP 429 + `retry-after: 60`: 1,800 playlist entries, 1,700 unique IDs; UI sync state reports `pending:false`, `count:1700`, `error:null`. The strict equality assertion fails in both cases. Evidence: `backend-probes.log`, lines containing `B9341-01 evidence` and the two preserved assertion failures.

Cause: the eight-write loop advances only a local offset. The offset is persisted only after the whole step returns. A throw leaves the prior persisted offset intact. Retrying a continuation repeats already acknowledged non-idempotent `addItems` calls. Returning success uses desired count, without checking actual playlist content. The 429 gate itself does not remove this replay problem.

Impact: the new promise of an exact, once-each private Likes playlist fails under normal provider faults. The user receives a false success state and duplicate songs. This violates P4 correctness/data integrity and the stated idempotency claim.

Repair direction: make continuation recovery reconcile the provider position/content or use an idempotent replacement/restart strategy; preserve correctness across acknowledged writes followed by errors and ambiguous transport outcomes. Require regression probes with failures after at least one append at a nonzero persisted offset, including 429, 500, budget exhaustion, and restart. Do not weaken the exact ordered equality assertion.

## B9341-02 — P1, blocking: a manual pause near the end triggers unwanted playback

Affected source: `src/worker/hub/hub.ts:5003`–`5013`, related `5034`–`5038`, and playback at `5057`–`5062`.

Preconditions: a saved TrueShuffle session exists; a 240-second outside song is playing at 60 seconds; the user arms “Nach diesem Song fortsetzen.”

Reproduce: second preserved probe uses public play/sync/continueAfter calls, advances to 235,000ms (five seconds before the end), sets FakeSpotify's provider-side `isPlaying=false` to simulate the listener manually pausing, asserts that actual paused progress equals 235,000ms, then lets normal scheduled alarms run for 60 seconds. No completion observation is supplied.

Expected: preserve the listener's stopped playback; no Spotify play command. This also follows AGENTS.md “Never infer completed listening from wall time alone,” MISSION NN-05 “do not commandeer unrelated playback,” and the changed function's own explicit claim that a stop before the end cancels.

Actual: the alarm issues one `PUT /v1/me/player/play`, switches to/resumes TrueShuffle, and reports continueAfter result `ok:true`. The strict no-play assertion fails. Evidence: `backend-probes.log`, `B9341-02 evidence` records `duration:240000`, `manuallyPausedAt:235000`, one unexpected play, and success result.

Cause: `endReached` adds elapsed wall time to a prior playing observation (with 20-second slack). On a fresh observation of the same paused song, code ignores that observation's actual progress and marks the intent due solely from the elapsed prediction. The next alarm starts music the listener paused.

Impact: autonomous playback overrides an explicit provider-side stop and the protected continuity/ownership requirement. This is a critical new transport behavior.

Repair direction: do not classify a paused or missing player as completed from elapsed prediction alone. Require positive observed end/transition evidence compatible with preserving manual stop and unrelated playback. Keep regression cases for natural end, manual pause near end, stopped/missing player, manual song choice near the expected end, and identity/device changes; do not weaken the no-play assertion.

## Evidence and reproduction

Probe file: `/workspace/review-evidence-9341/backend-review.test.ts` (also `/tmp/backend-review-9341/test/hub/backend-review.test.ts`).

Isolated checkout: `/tmp/backend-review-9341`, detached exact reviewed subject. Only new test file was written there; no application edits. node_modules is linked to the shared dependency installation. This reviewer made no writes to the canonical review checkout. It was clean at the start; final status shows `.impeccable/review/desktop.png` modified by concurrent work outside this subreview.

Command from isolated checkout:

```sh
node_modules/.bin/vitest run test/hub/backend-review.test.ts
```

Result: exit 1, 3 assertions fail (500 and 429 variants of B9341-01, plus B9341-02), 2.30 seconds. Log: `/workspace/review-evidence-9341/backend-probes.log`. These failures intentionally preserve expected behavior; they are not rewritten tests that pass by asserting the defect.

Existing source tests were run with `node_modules/.bin/vitest run test/hub/continue-after.test.ts test/hub/likes.test.ts test/worker/storage-limit.test.ts test/spotify/usage.test.ts`: exit 0, 4 files / 30 tests passed in 27.17 seconds. Log: `backend-existing-tests.log`. These green checked-in cases do not cover the three failing fault/manual-stop probes.

## NOT_RUN / limits

No production or GitHub operations. No live Spotify/HA/MA, physical iPhone/PWA, actual Cloudflare storage-limit exhaustion, populated live restore, or browser checks in this subreview. Root reviewer owns complete tests/browser gates. Storage-limit recognition and cache/operation-gate source were read, but this subreview establishes no comprehensive live quota classification or cross-account isolation acceptance. The fake returns acknowledged append failures deterministically; actual provider fault frequency is not measured. Fresh probes establish both backend defects without depending on that frequency.
