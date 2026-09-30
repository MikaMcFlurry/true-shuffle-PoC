# True Shuffle — continue the ACTUAL Cloudflare app

Repository: `MikaMcFlurry/true-shuffle-PoC`. Work on `codex/cloudflare-persistent-queue`, based on the deployed `claude/true-shuffle-spotify-95zw0m` at `c9bd08246487df1edcb5d19d39ec96c93f04fb9d`.

## Critical correction

`main` is the legacy Python/Fly.io prototype. Closed PR #7 mistakenly changed that prototype. Its 752 Python/29 browser test results and Listening Room screenshots DO NOT verify or modify the deployed Cloudflare app. Do not port Python code, ownership assumptions, migration commands or Fly deployment instructions into this implementation. This branch is a corrected continuation packet; it has no new functional fixes or redesigned UI yet.

Read `docs/LIVE_BASELINE_REVIEW.md` first: it records direct domain/asset comparison, all branch-head dates, withdrawn legacy claims and the explicit old test contract that conflicts with unfinished-song resume. Then read `docs/CLOUDFLARE_CONTINUATION.md`, `docs/SETUP.md`, `docs/LIVE_TEST.md`, `docs/adr/ADR-006-cloudflare-neustart.md`, `DESIGN.md`, and the installed project-local Impeccable skill. Matching frontend assets do not prove the deployed Worker commit; verify Cloudflare deployment metadata before live changes.

## Owner's requested outcome

Implement a persistent, indefinitely resumable queue. Closing the app, leaving the car, pausing for days, pressing Play in Spotify, changing devices, and HA/Music Assistant routes must preserve the same session and unfinished song. Resume the latest observed position; if unknown, replay the unfinished song rather than reshuffle. Preserve existing discovery, playlist resurfacing, history import, rules, ratings and exclusions.

Redesign the current radio interface independently using Impeccable. The owner chose a calm dark music-player direction with clear track, progress, transport, device and queue controls; also support mobile and light mode. Legacy Listening Room artifacts in closed PR #7 are direction references only, not a finished Cloudflare implementation.

Investigate the real Spotify quota response (status/reason/Retry-After, request volume) before claiming the production lockout fixed. No Client-ID cycling and no invented reset time. Respect durable cooldowns across all command and background paths. Audit account-wide request pressure and document process/account/developer-wide limits.

Implement and test the remaining work; do not merely produce another analysis. Preserve Durable Object identity, bindings, migration tags and existing user data. Do not change APP_SECRET, replace storage, delete history or rename UserHub/Registry classes. No production deploy or merge without release authorization. Verify simulated checks separately from live Spotify/HA behavior.

Run `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, appropriate Playwright and Wrangler dry-run checks. Then execute live acceptance scenarios from the continuation document. If access is missing, finish independent work and identify the exact missing access.
