# Repository intelligence — implemented local baseline

Analysis baseline: `d626befab883c0553351a753fa02aa6e1851b0fa` on `codex/implement-cloudflare-restart`. This generated view is bound to `repository-intelligence.json` and `HANDOFF_MAP.json`.

The Cloudflare/Preact implementation is deployed. Active source b64e03c09569bb4b763980ebdb6d0d5c78e5d263, version c3c3324b-cdab-4cee-a1a8-af69ca289d97, deployment e414b5c1-0a5e-46d3-871a-c5d6f1ce5f23 at 100% traffic. Production public/API/anonymous-browser readback passes. Durable per-station sessions retain the exact unfinished entry and latest observed progress; ordinary Resume preserves order, while explicit newQueue starts a new order. Queue extension and provider effects are journaled and fenced. The shared persistent quota gate records real provider metadata and blocks unknown-deadline requests until a deliberate probe. A separate authenticated HA/MA bridge declares actual capabilities and uses bounded native queue continuation.

The actual player was redesigned using the installed Impeccable skill. Five desktop/mobile/theme/offline captures, an explicit ambiguous-provider recovery capture and the scoped fresh finish verdict are committed. Existing rules, history, guest/private modes, favorites and bans remain supported.

Validation: 325 unit/Worker tests, 16 browser cases after the independently reviewed 401 fix, typecheck, lint, build and both deployment dry-runs pass. Fresh independent local review reports 49 targeted passing tests and no open blocking code finding. `EVIDENCE.json` remains PARTIAL and the production release verdict BLOCKED; fixtures do not establish live provider acceptance.

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

Cloudflare device OAuth, exact old/new versions and preserved namespace/secret bindings are verified. Wrangler was used because plugin discovery found no Cloudflare connector. The owner-authorized rollout and readback are complete. Full acceptance remains PARTIAL: owner Spotify/HA/MA playback/quota/device journeys and actual populated migration/history/restore checks are NOT_RUN. The old Worker version is retained and both namespaces are SQLite with documented30-dayPITR, but no object restore was performed. Continue those specific live checks, retaining the deployed reviewed code and storage identities; see CLOUDFLARE_DEPLOYMENT.json and RELEASE_RECOVERY.md.

Historical application provenance: `claude/true-shuffle-spotify-95zw0m` at `c9bd08246487df1edcb5d19d39ec96c93f04fb9d`. Task base: `codex/cloudflare-restart-plan` at `5ffe99b929b6a8ddf93035370e156fe036fe6a83`. Default main is the legacy Python/Fly implementation and is not this PR target.

Quota clarification followup: current source `b64e03c09569bb4b763980ebdb6d0d5c78e5d263` and GitHub Actions 36703665557 pass 325 unit/Worker tests and 17 browser cases. Four fresh independent actual-render cases cover known, expired, boundary and unknown waits. Backend/provider cadence is unchanged. Owner screenshot reports QUOTA_EXCEEDED with 30363-second Retry-After; owner confirms other development apps in the same developer account. Spotify documents a shared developer-account budget. Exact attribution, bucket size/reset window, later provider recovery and sustained owner usage remain unverified. See `docs/ai-dev/evidence/QUOTA_DIAGNOSIS.json`. Full acceptance stays PARTIAL.

Full-day usage audit: application/deployment unchanged. 326 local unit/Worker tests pass. Real HubCore/FakeSpotify after setup measures 856 calls for paused/closed, 2015 for 4h visible playback+20h paused/closed, 1748 for 4h closed playback+20h paused/closed; each includes 24 token refreshes. 3/5-user columns are arithmetic estimates, not live quota capacity. Spotify observations feed SQLite history; the current conservative all-endpoint gate stops fresh Spotify updates for the audited account. Owner-reported new history during the restriction remains to be reconciled with timestamps; do not dismiss it as merely a database read. Priorities are paused/background scheduling, freshness reuse, device caching and rolling real-call counters, with protected continuity verified. A distinct developer-account test requires Premium owner, allowlisted users, isolated preview namespaces/client credentials and fresh OAuth; it is not an established quota bypass. See `docs/SPOTIFY_USAGE_ANALYSIS.md` and `docs/ai-dev/evidence/FULL_DAY_USAGE_AUDIT.json`.
