# Cloudflare release and recovery

Production target: `true-shuffle`, https://true-shuffle.mikahertler-72c.workers.dev/. Implementation branch: `codex/implement-cloudflare-restart`, based on the Cloudflare restart packet. `main` is the historical Python implementation. The owner authorized deployment in the implementation session. Cloudflare authentication, the exact existing Worker version and live acceptance remain required external gates.

## Packaging and isolated preview

Run `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, and `npx wrangler deploy --dry-run --outdir /tmp/true-shuffle-worker`. In restricted environments use a writable npm cache, `XDG_CONFIG_HOME`, and `CHROMIUM_PATH=/usr/bin/chromium` as needed. The browser harness uses `true-shuffle-e2e`, localhost fake Spotify endpoints and its own SQLite state; it does not access production.

`wrangler.preview.jsonc` names `true-shuffle-preview`. Its self-bound `UserHub` and `Registry` namespaces belong to that separate script. Configure a dedicated test account, Spotify client and distinct `APP_SECRET` before a remote preview. Verify actual Cloudflare bindings and namespace IDs before test writes. No preview deployment or credentials were created in this session.

## Storage transition

The existing `v1` Cloudflare migration tag and Durable Object class/binding names remain unchanged. UserHub SQLite migration 4 adds only `playback_sessions`; the prior migrations remain verbatim. Registry adds a separate `spotify_gate` table without modifying `users`. Native bridge access is explicitly bound to an account in a server-side secret; credentials never enter client state or logs. Keep the production `APP_SECRET` unchanged.

Local verification covers migration transaction failure, 10,000 imported history entries with preferences and bans, and reopening a SQLite disk snapshot with the same occurrence and 1:37 checkpoint. `test/hub/recovery.test.ts` validates a snapshot made by SQLite `VACUUM INTO`, actual connection close/reopen, resume and history-count invariants. This is local recovery evidence, not a production backup.

Before production writes, record the existing deployment version, namespace IDs, variable names, schema version and permitted data-count invariants. Obtain an authorized production backup/recovery mechanism for the existing namespaces; it is unavailable in the current session. Do not substitute a D1 export command for Durable Object storage, delete user storage, recreate a namespace, or rotate `APP_SECRET`.

## Deployment and rollback boundary

For Workers Builds, keep repository root empty/default rather than `/`, build `npm run build`, deploy `npx wrangler deploy`, and deliberately select the verified Cloudflare implementation branch. A dashboard build configuration was not changed in this session.

After live acceptance and fresh review, publish the tested artifact with the existing `wrangler.jsonc`. Capture the resulting version/deployment ID, then verify authentication, history, mid-song resume, provider cooldown and supported owner devices against that exact deployment.

Rollback uses a previously recorded version ID: `npx wrangler versions deploy VERSION_ID@100% --name true-shuffle --yes`. The CLI command shape was inspected; no production version was selected or deployed. SQLite expansion leaves prior columns readable, but older application code does not understand the new checkpoint contract and may reshuffle music. A forward fix is preferred for continuity faults. Do not mark behavioral rollback compatibility proven solely because the old schema can still be read. Never drop the new table during rollback; stop playback writes and preserve checkpoints for repair.
