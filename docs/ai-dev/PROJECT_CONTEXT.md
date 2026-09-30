# Current application and production boundary

The implementation branch is `codex/implement-cloudflare-restart`, based on `5ffe99b929b6a8ddf93035370e156fe036fe6a83` from `codex/cloudflare-restart-plan`. The exact analyzed application revision is bound by HANDOFF_MAP.json and repository-intelligence.json. Default `main` remains the legacy Python/Fly prototype; it is not the merge or deployment target for this work.

The application is Preact/Vite, Hono and Cloudflare Workers with per-Spotify-account `UserHub` SQLite Durable Objects and shared `Registry`. Production remains https://true-shuffle.mikahertler-72c.workers.dev/. Public HTTP and frontend asset identity were checked against the starting app. Exact Worker deployment version, namespace IDs, production backup and runtime secrets remain unverified. There were no production writes or rollout.

## Delivered local behavior

- Additive SQLite migration 4 stores durable per-station playback sessions, stable occurrence IDs, observed position, epoch and pending intents. Existing stations, preferences, history and account identity are preserved. Normal Play resumes the held session; explicit newQueue creates a fresh run. Unknown progress replays the same unfinished occurrence from zero.
- Observations preserve backward seeks, reject stale or unrelated playback, recover prepared/submitted provider commands and keep hearing eligibility separate from occurrence completion. Bounded rolling queues retain the held entry across more than 10,000 simulated Spotify and native occurrences.
- All Spotify paths use persistent account/deployment quota policy, raw sanitized status/reason/Retry-After, monotonic cooldown and revision-fenced manual probe. Unknown deadlines remain closed. Local maintenance alarms do not retry the provider. A shared successful recheck supersedes stale account cooldowns.
- Native HA/MA is a separate authenticated capability-based controller. Its owner-configured local bridge uses official HA services; native Music Assistant receives ordered replacement/append lists, without replacing ongoing playback during refill. Commands and observations are fenced; ambiguous writes require deliberate recovery. Native newQueue plans locally without Spotify calls. Configuration, identity-feedback requirements and limits are in docs/NATIVE_PLAYBACK.md.
- The actual German Preact application uses a quiet album/queue shelf in dark/light/mobile layouts. Resume, saved position, devices, ordered queue, offline recovery and deliberate replacement are visible. Existing mix/rules/discovery/history/import/favourites/bans/guest/private functions remain available. DESIGN.md records the built system.

## Verification and evidence

The pristine application baseline passed 280 unit tests and 12 Chromium browser tests. Current exact results are in EVIDENCE.json and evidence/VALIDATION.json, not those historical baseline counts. Browser tests run a real local Worker/SQLite against an explicitly synthetic Spotify server, including another browser account session, reload, 1:37 pause/resume, phone reflow, long names, keyboard and offline state. Native bridge tests execute the actual Node bridge against a synthetic HA REST service.

Recovery tests reopen an actual SQLite disk snapshot and verify stable entry/position/history; failed additive migrations roll back their schema and version. This is not a production backup. Independent Red Team findings and fresh Impeccable finishing corrections are recorded separately. Review scope and exact source hashes must be retained when making claims.

## External gates and deployment

The user's current request explicitly authorizes deployment, superseding the original handoff's no-release-without-instruction rule. However, no Cloudflare connector is callable and Wrangler is not authenticated. Signed-in owner Spotify and private HA/MA access are also absent. The delivery claim therefore remains PARTIAL; PRODUCTION_LIVE is the target, not an achieved result.

Production and isolated-preview dry-runs preserve `UserHub`, `Registry`, `USER_HUB`, `REGISTRY`, migration tag `v1` and the existing `APP_SECRET`. `wrangler.preview.jsonc` creates separate self-bound namespaces under `true-shuffle-preview`; it has not been deployed. Run docs/RELEASE_RECOVERY.md preflight, actual backup/recovery, live Spotify/MA/native acceptance, rollout and read-back when access becomes available. Never infer a live quota fix from fixture tests, rotate Client IDs to evade quota, overwrite production identities or export Durable Objects using D1 commands.
