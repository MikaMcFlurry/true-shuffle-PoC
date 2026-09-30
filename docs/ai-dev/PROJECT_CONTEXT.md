# Current application and production boundary

Analyzed application source: `c9bd08246487df1edcb5d19d39ec96c93f04fb9d` on `claude/true-shuffle-spotify-95zw0m`. Handoff preparation baseline: `59174f6fc3d9da38dcc3a944c3524f8a6bc428f9` on `codex/cloudflare-restart-plan`. The latter adds workflow copies and prior corrected handoff documents; its newer date does not indicate newer application behavior.

Live URL: https://true-shuffle.mikahertler-72c.workers.dev/

The signed-out page was directly observed. Its script `/assets/index-B_uVw-Jk.js` and CSS `/assets/index-BjUUDnyv.css` match a local build of the source baseline. This establishes a matching frontend artifact, not the deployed Worker SHA or the current dashboard branch. Signed-in Spotify behavior, actual lockout reason/request volume, history integrity and HA/MA playback remain unverified. Do not infer those from frontend assets or owner symptoms.

GitHub: public repository; default `main` is legacy Python/Fly. All 16 branch heads were compared during the corrected audit. The newest pre-existing application branch is the September 27 Cloudflare branch above; our September 29/30 branches are preparation or withdrawn legacy work. PR #7 is closed and obsolete. PR #8 contains the earlier corrected packet, not product fixes. Fresh metadata inspection found no standalone issues or releases. Historical closed PRs are context, not current deployment authority.

## Runtime and data ownership

- `src/client`: Preact/Vite TypeScript UI; Store already refreshes visible/focused pages and prevents duplicate in-flight work. Do not implement a duplicate focus watcher as a fix.
- `src/worker/index.ts`: Hono Worker, signed user identity and routes. UserHub is addressed by Spotify UID, already supporting the same account across browsers. Registry rearms user alarms.
- `src/worker/hub/hub.ts`: HubCore, serialized IO, persisted jobs/backoffs, listening observations, station deck and playlist reconciliation. Existing pause/car-stop/guest/private tests and rolling rounds are valuable.
- `src/worker/hub/schema.ts`: append-only SQLite migrations; memory, listening history, stations/decks, imports, bans, discoveries, plays, jobs and events. A heard-history threshold is not proof of full-song completion.
- `src/worker/spotify/client.ts`: provider boundary. Confirm paths with `rg` before editing; location names are guidance, not frozen line numbers.
- `wrangler.jsonc`: static assets, UserHub/Registry SQLite-backed Durable Objects, cron, AI binding, node compatibility and retained variables. Preserve names, bindings, migration tags, stored identity and APP_SECRET.

## Confirmed product gaps

1. `test/hub/hub.test.ts`: “starting again never replays the same queue” expects reshuffling after a longer pause. This contradicts NN-03/04, not a missing test of the desired feature.
2. HubCore `play`: sync/rebuild conditions and start at playlist position 0 / position_ms 0 can replace or restart unfinished context. Durable checkpoint/resume semantics need an explicit contract.
3. Spotify `toError`: QUOTA_EXCEEDED currently receives a fixed one-hour delay; longer provider Retry-After is not safely retained. `setBackoff` overwrites rather than monotonically extending existing cooldown. Audit command/device/background paths, including ignored shuffle/repeat errors and playerAction.
4. Existing 30-second heard accounting and paused playlist trimming can remove an unfinished song. Separate queue occurrence completion from history/discovery eligibility.
5. Existing personal action keys implement like/dislike/skip, not a complete HA/MA resume adapter. A native MA queue must not be confused with Spotify Connect playback.

These are code-level findings and test-contract conflicts. The precise cause of the owner's current live limit exhaustion requires sanitized response and usage evidence.

## Setup and verification

Use Node >=22, `npm ci`, then `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`. `npm run test:e2e` runs the real local Worker with a Spotify stand-in and isolated state using `wrangler.e2e.jsonc`; it is not live Spotify proof. Install Playwright Chromium or set CHROMIUM_PATH to a real executable. Do not keep the absent old cache path.

The baseline build/typecheck/lint and 280 Vitest tests in nine files passed during the corrected analysis. The fresh restart rerun passed build/typecheck/lint and all 280 tests in 71.86 seconds. Wrangler 4.141.0 dry-run packaged the existing bindings without uploading. Results are recorded in EVIDENCE.json. In this restart session the browser suite stopped before exercising the application: Chromium absent; installation failed with a corrupt archive. There are 12 declared E2E cases, 11 skipped after launch failure. Do not report them as passing.

Local Worker packaging: `npx wrangler deploy --dry-run --outdir /tmp/true-shuffle-worker`. Live deployment is `npm run build` then `npx wrangler deploy`, only after environment/identity/storage review and release authorization. Preview must use separate test identity, secrets and Durable Object namespaces; a branch URL alone does not establish isolation. Verify the actual bindings before allowing test writes.

## Cloudflare build failure

Owner log 2026-09-29T22:53:13.172Z: `Failed: root directory not found` immediately after cloning, before build. Screenshot shows root `/`, build `npm run build`, deploy `npx wrangler deploy`, branch `claude/true-shuffle-spotify-95zw0m`. Repository SETUP says root directory should be empty/default. Clear the root field to default and retry as the first configuration check. The exact dashboard failure cause and a successful retry have not been verified. This is not evidence that Workers hosting no longer supports this app.

No Cloudflare connector was available in the inspected plugin inventory. No production secrets, Spotify account session, Home Assistant or Music Assistant instance was supplied. Finish fixtures/local changes without these; obtain scoped access only for the remaining environment-specific acceptance. Never publish tokens, account histories or secret values.

## Skills and provenance

Repository-local `.agents/skills/` includes existing Mika Dev Studio, Repo Intelligence, Product Director, Engineering, Verification, Red Team and Repo Handoff copies. MIKA_BUNDLE.json records source-content hashes. These are portable copies for Codex, not new personal skills.

Impeccable available bundle is 4.1.2. The npm installer channel reports 4.1.0; its online install/check failed at impeccable.style bundle DNS and changed no skill files. Do not downgrade the available bundle or claim successful online updating. Retry the documented update in Codex with working network and verify the resulting content/version. No new UI or application behavior is delivered by this handoff. The ledger records COMPROMISED/BLOCKED for the same-author diagnostic assessment of open target gaps; this is not a fresh independent Red Team review and cannot accept a material release.

Earlier docs/CLOUDFLARE_CONTINUATION.md and docs/LIVE_BASELINE_REVIEW.md are supporting transition history. The mapped packet and MISSION define the current restart. PRODUCT.md remains incumbent functional context; DESIGN.md is rejected incumbent visual context, not permission to retain the radio design.
