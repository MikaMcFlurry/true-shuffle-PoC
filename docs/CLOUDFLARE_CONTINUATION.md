# Correct deployment and continuation evidence

## Deployment identified 2026-09-30

Owner screenshot: repository MikaMcFlurry/true-shuffle-PoC; production branch claude/true-shuffle-spotify-95zw0m; build `npm run build`; deploy `npx wrangler deploy`; root field displayed `/`. Worker URL: https://true-shuffle.mikahertler-72c.workers.dev/ . Supplied build log stopped after cloning with `Failed: root directory not found`; no application build ran. The screenshot does not identify the exact commit of the last successful deployment.

docs/SETUP.md instructs leaving Root directory empty for repository root. Compare the failing build's settings with the successful production build, clear the root field to its documented empty default, and retry the existing production branch's failed build before changing architecture or merging. The dashboard setting cannot be repaired by adding a fake filesystem root or by merging the legacy Python PR. Inspect preview branch settings separately. No Cloudflare connector was available in this chat, so no dashboard settings were changed and no live deployment was performed.

## Actual architecture

- package.json: npm/Vite build, TypeScript, Biome, Vitest, Playwright, Wrangler; Node >=22.
- wrangler.jsonc: name true-shuffle, src/worker/index.ts, static assets dist/client, UserHub and Registry SQLite Durable Objects, v1 migration, cron safety net, Workers AI, keep_vars=true.
- src/worker/index.ts: signed Spotify identity selects USER_HUB.idFromName(uid). Unlike legacy main, this already has per-Spotify-account identity across browser logins; audit rather than replace it.
- src/worker/userhub.ts: exclusive promise chain serializes commands/background operations around network awaits.
- src/worker/hub/hub.ts: persistent KV backoff, jobs and alarm scheduling; playback/history/deck reconciliation; paused-station observation already exists via heldPace. Do not reuse the legacy claim that paused sessions have no observer.
- src/core/deck.ts: playlist version/progress reconciliation and retained continuation state; must preserve current behavior when changing the contract.
- src/client: Preact radio/dial UI, polling store, screens and styles. Redesign is not yet ported.

## Concrete audit starting points (hypotheses, not live diagnoses)

1. src/worker/spotify/client.ts toError: QUOTA_EXCEEDED uses a fixed 3,600,000 ms cooldown instead of respecting a longer returned Retry-After. Check reason handling and durable cooldown semantics. src/worker/hub/hub.ts setBackoff replaces the prior deadline; audit whether a shorter later refusal can shorten it.
2. HubCore.play forces sync, may rebuild a deck when consumed/continued/aged/dirty, and then plays position 0. SpotifyClient.play sends position_ms=0. This is a concrete mismatch with the owner's unfinished-song/minute resume contract; introduce explicit persistent resume versus intentional new-session behavior.
3. play ignores most errors while setting shuffle/repeat, including rate/quota; playerAction sends commands without the play method's early cooldown check. Audit all outbound paths, including devices, imports, discovery and concurrent user hubs. Do not report account-local backoff as a developer-wide global breaker.
4. heldPace and scheduleNext already observe paused contexts, but decay over hours/days. Verify stop/restart detection, stale observations, lifetime of retained context and request cost. Longer continuous polling is not automatically an improvement.
5. Preserve evidence-based history and private/guest-session behavior. Latest resume progress, maximum observed progress and heard/completed eligibility are distinct concepts.
6. Existing remote commands/authentication must be examined for HA/Music Assistant integration. A generic HA media_player or native MA queue is not automatically a Spotify Connect device. Identify actual versions/routes/capabilities before claiming integration.

## Implementation order

First reproduce build and baseline checks on the correct branch. Then instrument and fix quota handling with deterministic tests. Define session/queue identity and checkpoints independently of Spotify playlist materialization. Add resume behavior and device refresh, ensuring discovery/rules/history survive. Implement verified HA/MA adapter/event reconciliation as required by the installation. Redesign actual Preact screens with Impeccable and verify desktop/mobile/light/dark/accessibility. Finish live acceptance with deployment/storage checks.

## Acceptance scenarios

- Same account on two browsers/devices accesses the same queue and history without cross-account leakage.
- Leave car at 01:23 in an unfinished song, no timer-driven completion; return later through True Shuffle at saved position or restart that song if position unknown.
- Resume through Spotify Play after minutes, overnight and several days; reconcile same session, preserve the queue and no duplicate heard accounting.
- App remains open for hours, device disappears/reappears or changes; refresh and handle restricted/no-device errors without a new queue.
- Next/seek backwards/explicit new session remain distinguishable; observed backward seeks update resume position without corrupting completion evidence.
- Retry-After >1 hour survives all interactive/background paths and DO eviction. Concurrent hubs do not amplify quota failures.
- Queue horizon renews indefinitely while preserving preferences/discovery/rules and stable unfinished-song identity.
- Native Spotify, Spotify Connect-exposed MA player and native HA/MA route tested separately; unavailable routes explicitly reported.
- Redeploy retains Durable Object storage and OAuth identity; no migration resets. Preview has separate bindings/data and never controls production accidentally.

## Validation boundary

This corrected packet contains no functional changes yet. The previous 752/29 results are legacy-only and are not a baseline for this Cloudflare application. Real provider lockout cause and the exact deployed commit remain unverified. Record newly executed build/typecheck/tests and live checks independently here or in a new validation document.

Actual Cloudflare baseline checked on 2026-09-30: npm dependencies installed from package-lock.json; `npm run build` succeeded; `npm run typecheck` succeeded; `npm run lint` succeeded (67 files); `npm test` passed all 280 tests in 9 files; `npx wrangler deploy --dry-run` successfully bundled the Worker and assets with existing UserHub/Registry/AI/ASSETS bindings. No upload or production deployment occurred. No Playwright or live Spotify/HA checks were run in this correction. Vendored Impeccable formatting is upstream and excluded from application lint.
