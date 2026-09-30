# Repository intelligence — implemented local baseline

Analysis baseline: `23111bdc668bbae81ec03090ca45b6310e95c46d` on `codex/implement-cloudflare-restart`. This generated view is bound to `repository-intelligence.json` and `HANDOFF_MAP.json`.

The Cloudflare/Preact implementation is complete locally. Durable per-station sessions retain the exact unfinished entry and latest observed progress; ordinary Resume preserves order, while explicit newQueue starts a new order. Queue extension and provider effects are journaled and fenced. The shared persistent quota gate records real provider metadata and blocks unknown-deadline requests until a deliberate probe. A separate authenticated HA/MA bridge declares actual capabilities and uses bounded native queue continuation.

The actual player was redesigned using the installed Impeccable skill. Five desktop/mobile/theme/offline captures, an explicit ambiguous-provider recovery capture and the scoped fresh finish verdict are committed. Existing rules, history, guest/private modes, favorites and bans remain supported.

Validation: 325 unit/Worker tests, 15 browser cases, typecheck, lint, build and both deployment dry-runs pass. Fresh independent local review reports 49 targeted passing tests and no open blocking code finding. `EVIDENCE.json` remains PARTIAL and the production release verdict BLOCKED; fixtures do not establish live provider acceptance.

## Features

- F-01: Existing Worker/HubCore and fixtures; live authenticated behavior unavailable. (IMPLEMENTED_TESTED).
- F-02: Existing rules, history-driven deck and preferences; owner values results. (IMPLEMENTED_TESTED).
- F-03: Preserve existing storage and global taste accounting. (IMPLEMENTED_TESTED).
- F-04: Durable unfinished entry checkpoints preserve latest observations and reject unrelated/stale playback. (IMPLEMENTED_TESTED).
- F-05: SQLite sessions, stable entry IDs, explicit newQueue, bounded rolling queue and intent recovery implemented and locally tested. (IMPLEMENTED_TESTED).
- F-06: Persistent shared quota gate with raw provider metadata, revision fencing and measured request reduction; live quota cause unverified. (PARTIAL).
- F-07: Account-owned sessions and stale command fences implemented; local browser/device scenarios tested, real owner device acceptance unavailable. (IMPLEMENTED_TESTED).
- F-08: Separate capability-based native controller and authenticated local HA bridge implemented; real HA/MA acceptance unavailable. (PARTIAL).
- F-09: Independent calm German player replacement implemented in actual Preact application; desktop/mobile/dark/light evidence and fresh finish review referenced in ledger. (IMPLEMENTED_TESTED).

## Remaining access-dependent work

Cloudflare connector/authentication is absent. The public production URL responds, but exact deployed version, namespace/binding identity, APP_SECRET continuity and production backup/recovery are unverified. No production deployment occurred. Owner Spotify and private HA/MA credentials/devices are absent, so real resume, quota diagnosis, native transport and MA Spotify Connect acceptance are NOT_RUN.

Continue with the existing reviewed implementation: obtain those accesses, verify target and recovery, run protected live acceptance, deploy the reviewed revision and read it back. User authorization for deployment already exists. Use the prepared isolated preview configuration where appropriate. See `docs/RELEASE_RECOVERY.md`, `docs/NATIVE_PLAYBACK.md` and the verification ledger.

Historical application provenance: `claude/true-shuffle-spotify-95zw0m` at `c9bd08246487df1edcb5d19d39ec96c93f04fb9d`. Task base: `codex/cloudflare-restart-plan` at `5ffe99b929b6a8ddf93035370e156fe036fe6a83`. Default main is the legacy Python/Fly implementation and is not this PR target.
