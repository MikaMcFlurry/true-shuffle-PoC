# Fresh independent backend re-review of PR36

- SUBJECT: integrated source `2c6118f69c7671ea9efe506377f28d5d0376737b`, combined diff from `9341e0d3305778210adbf89e165ec3f66459a956`; PR36 head `99869b3f2d6e73fba7395022d847ab4474fad9b0`. Product changes traced to Mika Hertler commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (717d151, 1f25731, 088aaa6). No separate Claude GitHub login inferred.
- INDEPENDENCE = FRESH. Reviewer had no implementation role. Isolated clone `/workspace/true-shuffle-backend-review-131`, detached exact subject; shared dependency installation only. Read AGENTS, MISSION, actual source/tests/diff and Mika Red Team skill/independent contract/attack catalog. Builder reports are not acceptance evidence.
- VERDICT = BLOCKED. Two residual backend functional defects and the existing storage-classification blocker remain. No application fixes, production writes, merge, deploy or rollback by this reviewer.

## Reproduced repairs

`node_modules/.bin/vitest run test/hub/backend-review.test.ts test/hub/continue-after.test.ts test/hub/likes.test.ts test/worker/storage-limit.test.ts test/spotify/usage.test.ts`

PASS: 5 files / 49 tests, 29.47s. Includes unchanged three strict prior assertions: 1700 Likes exactly once and ordered after acknowledged append then 500 or 429, and preserving manual pause five seconds before the end. These previous concrete repros are repaired. Existing test green does not prove all interruption boundaries.

Evidence: `backend-existing-and-prior-probes.log`, unchanged prior probe preserved as `backend-prior-probes.test.ts`.

## B9341-02 residual — P1, blocking: early-end/crossfade inference still overrides manual listener actions

Affected: `src/worker/hub/hub.ts:5041`–5055 and 5081–5095; constants 324/330, subsequent automatic continue runner. Protected NN-05 requires not commandeering unrelated playback; owner also explicitly protects observed progress and manual stops.

Setup uses actual HubCore, node SQLite, SpotifyClient and FakeSpotify. Save/start a TS session; play an outside 240s song at 60s; observe it and arm continue-after via public APIs. No queue mutation or invented provider observation.

Reproduction A: advance actual playing time to 238000ms, 238001ms, or 239000ms; manually pause FakeSpotify provider; run ordinary alarms 60s. Each strict no-play assertion FAILS: `PUT /v1/me/player/play` occurs once and continueAfter reports `ok:true`. Control pause at 237999ms (2001ms before end) passes. Thus the former 5s defect is reduced to a two-second window, not eliminated. The live observation explicitly says paused before duration; code treats the last 2000ms as completed regardless.

Reproduction B: at 5s or 12s before that outside song's end, manually select a different song outside the saved TS deck with `fake.playSong`; run ordinary alarms 60s. Both strict no-play assertions FAIL: listener-selected outside track `...007` is cut to TS track `...001`, one PUT play, result `ok:true`. This needs neither unobserved pause nor seek. The 12s crossfade heuristic classifies a manual selection as automatic. A prior armed wish after the old song does not authorize cutting a different listener-selected song.

Impact: unwanted automatic playback and overriding a new listener choice. This is a residual of the previously reported transport defect, not a new duplicate finding and not a cosmetic concern. Builder documentation acknowledges a two-second pause edge and other transport limitations; labelling them P3 does not satisfy the explicit no-commandeering contract.

Expected: preserve observed manual pause and unrelated new selection; ambiguous transition must not trigger automatic play. Repair needs explicit positive completion/transition evidence, or conservative cancellation when the endpoint cannot distinguish the cases. Preserve natural-end positive tests. Required strict regressions: pause at d-2001/d-2000/d-1999/d-1000; manual next-song choice d-12000/d-5000; natural end and legitimate crossfade; device/occurrence switches; absence of player. Never replace strict no-play assertions with assertions accepting the cut.

Direct evidence: `backend-boundaries.log` R131-PAUSE / R131-PICK; reproducible `backend-boundaries.test.ts` (place in `test/hub/`).

## B9341-01 residual — P2, blocking: ambiguous write reconciliation trusts length as proof of content

Affected: `src/worker/hub/hub.ts:5280` recovery and `settleLikesWrite` 5352–5361; false success 5331–5337.

Repro: plant 1700 exact ordered valid Likes; start public retryLikesSync. On continuation after 900 acknowledged tracks, simulate append of tracks 900..999 reaching provider but response lost (502), plus same-length external edit of one of those appended entries (replace index950 with index0). This models listener editing their own private playlist while recovery is pending. Continue normal alarms through completion.

Expected: exact 1700 requested Likes in order, each once, or explicit unresolved/failed recovery. Actual: 1700 entries but only 1699 unique, track950 missing and track0 duplicated; status `pending:false,count:1700,error:null`. Strict full ordered equality FAILS. The new builder test already claims to recover external playlist change but only changes length; a same-length edit bypasses its check. This is synthetic provider behavior and says nothing about live fault frequency.

Cause: total==sent.to advances offset without checking returned items/snapshot/content identity. A count is insufficient evidence that the proposed batch arrived intact. The declared exact-once recovery guarantee is stronger than this implementation.

Repair direction: conservatively restart with replace after an ambiguous append, or verify provider content/snapshot against the expected prefix before continuing. Required regression: ambiguous append with same-length edit/reorder, failed append plus equal-count manual append, true successful append, unchanged successful 500/429/budget/restart tests; keep ordered equality and honest unresolved state.

Direct evidence: `backend-boundaries.log` R131-LIKES and same probe file.

## PR31-STORAGE-CLASSIFICATION — P2, blocking, unchanged existing finding

`src/worker/lib/storage-limit.ts:11,16` includes SQLITE_FULL and `storageLimitMessage:22` guarantees the daily Berlin reset. Worker handlers `index.ts:832` and `userhub.ts:125` apply that message. No diff here in PR36. Fresh assertion confirms `isStorageLimit(new Error('SQLITE_FULL: database or disk is full')) === true`; resulting message at 2026-11-08 noon UTC is “Das Tageslimit ... Ab 01:00 Uhr geht es weiter, deine Daten bleiben erhalten.” Disk/database fullness is not proof of daily rows quota/reset. Strict negative classifier test FAILS. Existing ordinary CPU/timeout exclusion is preserved.

Carry this existing finding forward, do not post a duplicate unchanged comment. Required repair remains truthful cause separation and no guaranteed recovery without endpoint/provider evidence, with Worker/RPC/client regression.

## Own probe result and limits

`node_modules/.bin/vitest run test/hub/review131-boundaries.test.ts`: 8 tests, 1 PASS / 7 FAIL, 2.17s (exit1). Failing expectations intentionally assert the protected behavior. No test is rewritten to pass by accepting the bug. Final probe source copied to `backend-boundaries.test.ts`; full raw log retained.

This is a scoped backend review, not a complete release acceptance. Root owns comprehensive typecheck/lint/build/Unit/Worker/browser and deployment readback. Physical iPhone/PWA, real Spotify writes/latency/quota/crossfade/ambiguous network behavior, private HA/MA and populated production restore are NOT_RUN. No secrets or real history used. Current Handoff Map baseline09d772e and AGENTS's current1.3.0 are stale relative to exact2c6118f; they were navigation only. No live outage or rollback necessity is established by these synthetic probes.
