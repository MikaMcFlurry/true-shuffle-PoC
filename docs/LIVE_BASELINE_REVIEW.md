# Live baseline and correction review — 2026-09-30

## Verdict

Closed PR #7 is not a reviewable improvement to the owner's running app. It targets the discarded Python prototype. PR #8 is a corrected agent handoff and installed design skill, not a redesigned or fixed product. No new functional or visual changes should be claimed ready for the owner to test.

The current Cloudflare implementation is substantially more capable than the legacy prototype. Retain it and change the incompatible product contract deliberately, rather than rebuild it from the legacy analysis.

## Live observations

Opened https://true-shuffle.mikahertler-72c.workers.dev/ directly in the browser. The live page renders the wooden radio design and a Spotify sign-in screen. DOM scripts: `/assets/index-B_uVw-Jk.js`; stylesheet: `/assets/index-BjUUDnyv.css`. Both match the local Vite build from `claude/true-shuffle-spotify-95zw0m` at c9bd082, unchanged by PR #8.

This establishes matching frontend asset identifiers, not a proven Worker commit or the owner's historical deployed version. The same client may accompany different server commits. The public `/api/health` navigation was blocked by this browser's client/network policy; the application endpoint was not observed. No authenticated playback, production user data, Spotify error logs or HA installation were accessed. No production settings or playback were changed.

## GitHub branch inventory checked live

All 16 branch heads were retrieved and their commit timestamps compared.

| Branch | Head | Commit time (UTC) | Meaning |
| --- | --- | --- | --- |
| claude/true-shuffle-spotify-95zw0m | c9bd082 | 2026-09-27 10:10:36 | Latest pre-existing application branch; Cloudflare settings screenshot selects it; matching live frontend |
| main | db73bc5 | 2026-08-02 09:11:38 | Discarded Python prototype; wrong starting point for the running app |
| codex/persistent-queue-redesign | 02f1b5d | 2026-09-29 22:52:46 | Erroneous legacy work, closed PR #7; newer timestamp does not mean newer product |
| codex/cloudflare-persistent-queue | 6074e38 (before this report) | 2026-09-30 03:14:10 | Correct base plus handoff/skill only; no application code changed |

The other 12 branch heads predate the September Cloudflare branch. A newer branch name/timestamp alone is not a deployment signal. The exact Worker version and the last successful production build still require Cloudflare deployment metadata.

## Which earlier claims were wrong

| Earlier legacy finding | Actual Cloudflare evidence | Consequence |
| --- | --- | --- |
| Browser-local random identity blocks shared account continuity | src/worker/index.ts signs uid and selects USER_HUB.idFromName(uid) | Account-based identity already exists; preserve and verify it |
| Paused runs are not monitored | HubCore.heldPace and scheduleNext monitor paused/retained station contexts | Audit gaps and costs rather than add a second competing observer |
| Cooldown exists only in process memory | HubCore stores backoff in durable KV | Existing cooldown survives object recreation; inspect bypass paths and shared developer quota separately |
| App needs a Fly/Docker runtime | wrangler.jsonc, UserHub/Registry and successful Wrangler dry-run | Keep the working Workers architecture |
| Return-to-tab/device state needs to be added | Store.start already refreshes on visibility/focus with an inflight guard; pickDevice fetches current devices on play | Reproduce specific failures rather than duplicate features |
| Python resume/design fixes improve the live app | Different source trees and runtimes; PR #8 changes no src files | Those improvements are not delivered to the live app |
| 752 Python and 29 browser passes verify the current version | Those tests exercise legacy Python code | Withdraw them as evidence for current Cloudflare behavior |

## Highest-value actual findings

1. **The current restart policy conflicts with the owner.** test/hub/hub.test.ts explicitly requires "starting again never replays the same queue". HubCore.play may rebuild consumed/continued/aged/dirty decks and starts at playlist position 0. SpotifyClient.play always sends position_ms=0. The requested default is a resumable session with the same unfinished song, so change the API/UI/state contract and the old expectation together. Retain an explicit intentional new-session action if needed.
2. **Partly heard is not necessarily finished.** Existing tests rewrite paused playlists without songs already recorded in plays; robustness tests even expect the paused song absent from rewritten playlists. A 30-second play/history entry cannot by itself prove the owner finished the song. Preserve discovery/history semantics while storing separate unfinished-song checkpoint and completion evidence.
3. **Quota handling still has concrete weaknesses.** QUOTA_EXCEEDED gets a fixed one-hour delay even if Spotify supplies a longer Retry-After. setBackoff overwrites the prior deadline. playerAction/devices and swallowed shuffle/repeat failures need cooldown-path tests. These are code-backed risks, not proof of the live lockout cause. Existing tests already prove alarm backoff for one simulated quota event.
4. **Spotify-side continuity already exists in part.** Car-stop, paused-order, private/guest-history, restart-from-top and hub-restart scenarios are covered by existing tests. Preserve these while adding exact unfinished-song resume; do not replace the reconciliation algorithm casually.
5. **Remote is not a complete HA/MA playback adapter.** Existing authenticated remote actions provide favourites, exclusion and next. Verify actual player capabilities/events and design a deliberate playback route before claiming start/resume across native MA queues or arbitrary HA devices.
6. **The fake player does not fully prove position resume.** test/fakes/fake-spotify.ts handles context/offset or no-body resume; audit and extend its position_ms/seek behavior before relying on new checkpoint tests.

## Verified baseline, not a new release

Executed on the correct Cloudflare branch: npm build, TypeScript, Biome (67 files), 280 Vitest tests (9 files), and Wrangler deploy --dry-run succeeded. No upload/deployment occurred. These prove the existing simulated baseline and build packaging; they do not prove the user's live Spotify/HA cases. No additional application tests were needed for this documentation-only review.

## Correct next implementation and review bar

Start from this branch's CODEX_START.md, preserve current account storage and discovery/rules/history, and use the installed Impeccable skill. Define durable session/checkpoint identity and explicit resume/new-session actions; fix quota paths with tests; verify device changes and actual HA/MA routes; implement the independent calm music-player UI in src/client. Add deterministic tests for paused unfinished songs after 30 seconds, accurate position_ms, backwards seeks, DO restart, days-long pause, Spotify Play and rolling queue renewal. Re-run the existing regressions to prevent discovery/history degradation.

Only then present a new product for owner review with real screenshots, changed-behavior evidence, an isolated preview, migration/storage verification and explicitly separated live versus simulated results. Do not ask the owner to review or merge a handoff-only PR as if it were the requested improved app.
