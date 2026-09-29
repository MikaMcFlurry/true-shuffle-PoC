# Current state and recovery analysis

Assessed 2026-09-29 against main commit `db73bc5` (merge of PR #6). Code was cloned and run locally. No production credentials, production DB, Spotify error response, Home Assistant instance or Music Assistant instance were available. Findings identify code defects and architectural gaps; the exact live cause of the current lockout is unconfirmed.

## Evidence

| Symptom | Current implementation evidence | Consequence |
|---|---|---|
| Every limit says quota exhausted | `providers/base.py` mapped all `ProviderQuotaError` to the same sentence | A temporary 429 looks like exhausted developer quota |
| Long rate limits keep receiving requests | `providers/http.py` slept `min(Retry-After,30)`; final errors lost the header | A 120-second refusal could receive another request after 30 seconds |
| Background retries are renewed | `app/watcher.py` stops after ten failures; `ensure_all()` restarts every ACTIVE run; supervisor every 60s | The comment claiming the supervisor will not re-arm failures was false |
| Paused listening still polls heavily | `_next_delay()` returned 4s for idle and 8s for drift despite a 30s configured ceiling | Hours parked still spend requests; stopping after 15min is undone by supervisor re-arm |
| Other browser/device cannot see the run | `app/deps.py`: signed random browser handle is the identity; OAuth accounts attach to that local user | Same Spotify account on another browser is not automatically the same True Shuffle owner |
| Position gone after lunch or next day | `_resume_position_ms()`: default 600s age limit | Same card resumes at 0 even when a persisted checkpoint exists |
| Old tab does not follow external resume reliably | `player.js` boot used watcher liveness as playback evidence, only polled while it thought it was playing, stopped on pause | UI/controls can remain stale after a phone sleeps or a Spotify-side action |
| API requests needed just to render history/queue | `runs.describe()` always calls `resolve_tracks`; Spotify cache is process-local, TTL 1h | Restart and cache expiry request up to ten single-track reads per view despite imported metadata |
| HA / MA unsupported as native playback targets | No Home Assistant or Music Assistant connector in `providers/registry.py`; device list only provider-reported devices | A native MA player/queue is not necessarily a Spotify Connect session |

## Implemented in this branch

- Shared process-local provider/host cooldown for 429s across library, watcher and player paths; long `Retry-After` is returned immediately rather than truncated. Short waits are respected fully. `QUOTA_EXCEEDED` suppresses further requests for at least 15 minutes or the longer provider header. This is a conservative probe interval, NOT Spotify's documented reset time.
- Typed retry duration/reason, distinct German messages and `Retry-After` response header, including the app's custom HTTP exception handler.
- Imported run metadata is used for display before provider lookups. Legacy runs without stored track rows still use the connector fallback.
- Saved unfinished-card checkpoints do not expire by default (`RESUME_POSITION_MAX_AGE_SECONDS=0`). Positive age limits remain configurable. Same card must still match, and a card already satisfied under the user's played-threshold policy is intentionally settled as before.
- Idle/drift watcher intervals use the quiet cap (30 seconds by default).
- Remote UI reloads state on visibility/pageshow/online, polls paused sessions too, skips hidden-tab polls, prevents overlapping polls, refreshes devices before starting, and offers a manual device refresh. A watcher alone no longer means the Pause button should be shown.
- Listening Room design: self-hosted Archivo, warm near-black and mint, desktop navigation rail, song/transport/device first, adjacent queue; mobile compact song row. Both themes and all user controls preserved.
- Project-local Impeccable 4.1.2 installed from the available bundle; remote update unsuccessful, see IMPECCABLE.md.

## Still open — do not claim solved

1. Durable cooldown and diagnostics across process restarts / replicas. Current cooldown is in-memory. Multiple processes, other apps using the same Spotify developer account and a restart can still issue requests outside this guard. The connector cannot discover all sibling Client IDs.
2. Account identity and secure device pairing. Never merge local users merely because an unauthenticated request names a Spotify user ID. Existing library/run/history ownership must be migrated safely, preserving the beta access gate.
3. A persistent listening-session supervisor that follows provider-side resume after a True Shuffle pause, days parked, server restart, car disconnect and device transfer. The current `PAUSED` run is excluded by `ensure_all()`, so Spotify-side Play does not automatically reactivate it. Natural silence on an ACTIVE run is still observed/re-armed; these are different paths.
4. Resume checkpoint vs consumed-progress separation. `record_observation()` stores MAX progress to protect played accounting; seeking backwards cannot be represented as a separate exact resume checkpoint yet. Polling misses up to the interval, and cannot reconstruct an exact minute after a long blind interval. Add a current-position checkpoint separately from monotonic eligibility evidence.
5. Missing observations and listening history. Spotify history is finite and not a complete completion receipt. Do not infer completed cards merely from elapsed wall time. Catch-up must deduplicate provider timestamps/events and retain uncertainty when evidence is insufficient.
6. Infinite continuity: distinguish queue horizon from finite deck cycle; preserve run identity, preferences, suggestion logic and ledger across automatic replenishment/cycle change. Respect no-repeat semantics and explicit user thresholds/skip rules.
7. Native Home Assistant / Music Assistant integration. Spotify Connect is one route, not proof that all MA queue playback is visible in Spotify Web API.
8. Live validation and deployment: not done. Main remains untouched. The branch is a tested foundation plus a continuation packet, not a release claiming all use cases work.

## Official sources checked

- https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates
- https://developer.spotify.com/documentation/web-api/references/changes/july-2026
- https://developer.spotify.com/documentation/web-api/concepts/rate-limits
- https://www.music-assistant.io/plugins/spotify-connect/
- https://www.music-assistant.io/music-providers/spotify/
- https://www.home-assistant.io/integrations/music_assistant

Spotify development Client IDs belonging to one developer account share quota. Rotating Client IDs is therefore not a demonstrated fix. Music Assistant's Spotify Connect plugin can advertise MA players/groups as Spotify devices. Native MA playback and that plugin must be tested separately.
