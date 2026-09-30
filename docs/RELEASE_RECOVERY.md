# Cloudflare release and recovery

Production target: `true-shuffle`, https://true-shuffle.mikahertler-72c.workers.dev/. Implementation branch: `codex/implement-cloudflare-restart`, based on the Cloudflare restart packet. `main` is the historical Python implementation. The owner authorized deployment in the implementation session. Cloudflare authentication and exact version/binding readback are now established. Active version `c3c3324b-cdab-4cee-a1a8-af69ca289d97`, deployment `e414b5c1-0a5e-46d3-871a-c5d6f1ce5f23`, source `b64e03c09569bb4b763980ebdb6d0d5c78e5d263` at 100% traffic. Public/API/anonymous-browser smoke passes. Owner Spotify/HA/MA and actual populated-storage restore acceptance remain NOT_RUN; full acceptance is PARTIAL.

## Packaging and isolated preview

Run `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, and `npx wrangler deploy --dry-run --outdir /tmp/true-shuffle-worker`. In restricted environments use a writable npm cache, `XDG_CONFIG_HOME`, and `CHROMIUM_PATH=/usr/bin/chromium` as needed. The browser harness uses `true-shuffle-e2e`, localhost fake Spotify endpoints and its own SQLite state; it does not access production.

`wrangler.preview.jsonc` names `true-shuffle-preview`. Its self-bound `UserHub` and `Registry` namespaces belong to that separate script. Configure a dedicated test account, Spotify client and distinct `APP_SECRET` before a remote preview. Verify actual Cloudflare bindings and namespace IDs before test writes. No preview deployment or credentials were created in this session.

## Storage transition

The existing `v1` Cloudflare migration tag and Durable Object class/binding names remain unchanged. UserHub SQLite migration 4 adds only `playback_sessions`; the prior migrations remain verbatim. Registry adds a separate `spotify_gate` table without modifying `users`. Native bridge access is explicitly bound to an account in a server-side secret; credentials never enter client state or logs. Keep the production `APP_SECRET` unchanged.

Local verification covers migration transaction failure, 10,000 imported history entries with preferences and bans, and reopening a SQLite disk snapshot with the same occurrence and 1:37 checkpoint. `test/hub/recovery.test.ts` validates a snapshot made by SQLite `VACUUM INTO`, actual connection close/reopen, resume and history-count invariants. This is local recovery evidence, not a production backup.

Before production writes, record the existing deployment version, namespace IDs, variable names, schema version and permitted data-count invariants. Obtain an authorized production backup/recovery mechanism for the existing namespaces; actual export/bookmark/restore was not performed in this session. Both existing namespaces are confirmed SQLite; Cloudflare documents 30-day PITR, which is recovery capability rather than a verified restore. Do not substitute a D1 export command for Durable Object storage, delete user storage, recreate a namespace, or rotate `APP_SECRET`.

## Deployment and rollback boundary

For Workers Builds, keep repository root empty/default rather than `/`, build `npm run build`, deploy `npx wrangler deploy`, and deliberately select the verified Cloudflare implementation branch. A dashboard build configuration was not changed in this session. The authorized rollout used immutable Wrangler version upload followed by 100% promotion.

After live acceptance and fresh review, publish the tested artifact with the existing `wrangler.jsonc`. Capture the resulting version/deployment ID, then verify authentication, history, mid-song resume, provider cooldown and supported owner devices against that exact deployment.

Rollback uses a previously recorded version ID: `npx wrangler versions deploy VERSION_ID@100% --name true-shuffle --yes`. The CLI command shape was inspected; old version `c193ca15-8503-4e18-ac78-a8ac398289cb` was recorded and retained, and new version `c3c3324b-cdab-4cee-a1a8-af69ca289d97` was selected/deployed. No rollback or database restore was executed. SQLite expansion leaves prior columns readable, but older application code does not understand the new checkpoint contract and may reshuffle music. A forward fix is preferred for continuity faults. Do not mark behavioral rollback compatibility proven solely because the old schema can still be read. Never drop the new table during rollback; stop playback writes and preserve checkpoints for repair.

## Observed rollout

See `docs/ai-dev/evidence/CLOUDFLARE_DEPLOYMENT.json`. `USER_HUB`/`REGISTRY`, all existing secrets and variables, compatibility settings and migrationv1 were compared before promotion and preserved. Public JavaScript/CSS bytes match the tested local build; health is configured/ok; protected anonymous APIs return 401 and unsigned mutations 403. The first live anonymous browser check found a false offline banner after 401; a one-line store correction,16 browser regressions and5 independent state checks passed, and corrected source was uploaded/promoted/read back. This smoke did not run populated UserHub migrations, playback or provider quota calls.

Quota diagnostics followup: current source b64e03c09569bb4b763980ebdb6d0d5c78e5d263 passed17 browser cases and GitHub Actions36703665557, with four independent actual-render quota cases. Existing backend, namespaces, secrets and provider cadence remain identical. See `docs/ai-dev/evidence/QUOTA_DIAGNOSIS.json`: the owner reports an active Spotify restriction and other apps in the same developer account. This rollout clarifies local blocked attempts, human wait/timezone and manual probe availability; it does not establish provider recovery or account-wide sustainable usage.
