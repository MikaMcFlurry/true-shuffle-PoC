## Current implementation outcome

Implementation delivered on codex/implement-cloudflare-restart. Source identity, durable queue/checkpoints, persistent quota protection, capability-based native HA/MA, explicit native/Spotify newQueue and the actual calm Preact player are implemented. Integrated local results and fresh review evidence are recorded in EVIDENCE.json and evidence/VALIDATION.json. Repaired Red Team findings and Impeccable corrections retain their scoped evidence.

Remaining work requires external access: exact Cloudflare version/bindings/backup, real Spotify quota/playback acceptance, private HA/MA and MA Spotify Connect acceptance, then the explicitly authorized rollout and production read-back. Current claim PARTIAL; no production changes. Follow RELEASE_RECOVERY.md. The original acceptance specification follows; it is no longer a list of unimplemented local features.


# Implementation contracts and delivery order

Implement using Mika Dev Studio in AUTONOMOUS_BUILD mode. Start with refreshed Repository Intelligence; resolve actual deployment identity, then Product Director, Engineering, Impeccable, Verification and fresh Red Team as applicable. This is an implementation mission, not permission to stop at another handoff. Missing live access blocks only the corresponding live claims.

## 1. Establish the reproducible harness and observe quota

Recheck branch heads, source hashes and provider metadata; invalidate changed evidence. Restore the 12-case browser harness using an installed compatible browser. Preserve the existing real-Worker/SQLite stand-in tests; extend FakeSpotify to model position_ms, context offset, seek, paused state, device changes, unavailable/restricted devices and retry headers accurately. Keep a deterministic clock and controllable events, not elapsed-time sleeps. Capture sanitized endpoint, status, reason, Retry-After, call category and counts per observation period; never log tokens or full listener history. Measure visible/hidden/paused/device/reload/multiple-tab request pressure before tuning budgets.

## 2. Durable queue and checkpoint vertical slice

Define account-owned sessionId, stable queue entryId (track ID alone cannot identify repeated occurrences), order revision, current entry, latest observed progress, observation timestamp, playback epoch, provider context and device/capabilities. Persist in the existing UserHub with additive migrations. Maintain an operation journal or equally durable retry contract for pending provider changes: local commit plus failed remote request cannot silently produce a different queue.

Separate `resumeSession` from explicit `newSession`; ordinary station Play resumes a saved session. Distinguish paused, disconnected, active, exhausted, external/unrelated and ambiguous states. Pause, missing device, expired access token, quota, browser closure and Worker restart cannot consume or replace the unfinished entry. Completion requires trusted provider observations/transition reconciliation or explicit user skip, never elapsed wall time alone. Heard history remains independent. Latest valid observation wins, including backwards seek; do not blindly take the maximum progress. If offset is stale/unsupported, replay the same unfinished occurrence from zero.

Reconcile Spotify context, queue occurrence, provider offset and playback epoch. Recognize Play in Spotify for the held session without rebuilding it. Never move playback back when the user selected unrelated music. Stale tabs, duplicated events, reordered callbacks and concurrent commands must be fenced/idempotent. Resolve playlist rewrite offsets against stable entries; preserve the unfinished occurrence when filtering heard songs and when rolling to another round. Continue background work through existing alarms, with provider-aware bounded request pressure. No timer-based promise of indefinitely exact playback when provider observations are unavailable.

Migration: snapshot/export current test storage, retain legacy decks and all history; derive checkpoints only from trustworthy saved observations. Missing progress must remain unknown with same-song fallback. Test upgrade with large imported history and rollback compatibility before live writes. Do not remove SQLite migration entries, rename DO classes or change APP_SECRET. Document downgrade policy before adding fields older code cannot read; restore a previous Worker version only with verified schema compatibility.

## 3. Quota and device reliability vertical slice

Parse status/body reason independently of message text, preserve raw sanitized retry metadata, and compute durable cooldown as at least the provider's Retry-After and existing later deadline. Do not assume quota resets after one hour or that all 429s are short rate limits. All provider requests must use one policy, including device enumeration, player actions, shuffle/repeat, sync, playlist writes, imports and alarms. Persist pending intent without executing forbidden retries. Surface a truthful saved-queue/cooldown state and cancellable retry, without losing the session.

Developer-account development quota can span Client IDs; coordination inside this deployment cannot enforce other applications' traffic. No Client-ID cycling. Cache/batch/lazy-load safe reads, deduplicate tab refreshes, avoid rebuilding playlists unnecessarily, pace idle observations and measure before/after. Retain external-Play detection within observed provider constraints and make uncertain state honest. Device selection is fresh at command time; handle changed IDs, transfer/seek capabilities and provider restriction errors without destructive session reset.

## 4. Home Assistant and Music Assistant vertical slice

Use a capability-based controller contract: list/select devices, resume/pause/skip, supported seek, observe playback, context identity and disconnect behavior. Route A uses a Music Assistant Spotify Connect device when it is actually advertised and controllable via Spotify; verify this on the owner's version/network rather than asserting all HA entities are Spotify devices.

Route B is native MA/HA playback, with its own controller/queue identity, supported seek and trusted state events. True Shuffle owns ordering/checkpoints; a remote service transports music. Choose a minimal authenticated local bridge or equivalent explicitly configured reachable adapter after checking official APIs and the actual network. A public Worker cannot assume access to a private LAN. Authentication, event sequencing, command idempotency, account authorization and revoked access must be tested. UI presents only supported capabilities; unsupported routes explain what setup is missing without advertising fake functionality. A supported Spotify Connect route alone does not complete the generic native-player requirement.

## 5. Independent design and integrated verification

Use the project-local Impeccable context workflow and MISSION brief. Build the real Preact screens and states, preserve the existing controls under a clearer hierarchy, and update DESIGN.md/.impeccable metadata only for implemented truth. Render actual desktop and phone screenshots, signed-in fixtures and failure states; review contrast, focus, touch, overflow, semantic labels and reduced motion. Finish/document with the skill's bounded review process. A direction card or screenshot of another branch is not implementation evidence.

Integrate all slices. Run combined build/static/unit/Worker/browser checks, append-only migration/recovery tests and the acceptance matrix below. Update Repository Intelligence, Handoff Map, execution checkpoint and Evidence Ledger when their subjects change. Obtain a fresh independent material-release review through Mika Red Team only after implementation; no independent-review claim exists for this planning packet.

## Acceptance matrix

| Requirement | Implementation/verification surface | Required acceptance |
|---|---|---|
| NN-01 | GitHub, Wrangler, assets, provider metadata | Exact source/deployment mapping; isolated preview proven before writes |
| NN-02 | schema/store/account routes | Existing history, stations and preference fixtures preserved through upgrade/restart; second account isolated |
| NN-03 | session command contract, hub tests | Play after minutes/days resumes same session/order; explicit new-queue action creates a new one |
| NN-04 | checkpoint + FakeSpotify | Pause at 1:37, restart Worker/browser and resume same entry at observed position; unknown/unsupported seek replays same entry |
| NN-05 | observer/reconciliation | Car disconnect then Spotify-side Play continues held session; unrelated playback is untouched |
| NN-06 | Store + controller | Two browsers and device switch, stale tab/ID, concurrent resume, failed transfer; no competing queue/reset |
| NN-07 | alarms + rolling rounds | App closed, restart, cooldown and round boundary do not skip unfinished entry or lose order/history |
| NN-08 | regression suites + screen inventory | Rules, mix, discovery, favourites, bans/import and private/guest protections retained |
| NN-09 | provider boundary + request counters | Long/missing Retry-After, repeated quota across all paths, two listeners/tabs and background sync; no early retry or invented reset |
| NN-10 | two controller routes | Actual MA Connect playback and separate native HA/MA play/pause/disconnect/resume; fixture plus live supported-route evidence |
| NN-11 | Preact + browser/screenshots | Phone/desktop/light/dark; track, saved position, device and ordered queue clear; all failure states operable/accessibly labelled |

Live final story: resume in car → stop mid-song → leave app closed → later Spotify Play on another device → reconnect via MA/HA → switch browser → hit provider cooldown → restart Worker → resume same saved entry/order. Use a test account and isolated preview first. Final report must state separately: implemented, simulated PASS/FAIL, live verified, and access-blocked. Do not mark the product release-ready while protected requirements or material recovery gates remain unproven.
