# Persistent listening-session implementation

## 1. Diagnose real provider lockout, preserve data

Read the deployed revision/configuration and sanitized Spotify error status, reason and Retry-After. Inspect request volume by endpoint, active watcher count, import jobs and other developer-account applications (including HA) without exposing credentials. Back up SQLite plus its encryption key securely. Determine whether current message is temporary throttling, `QUOTA_EXCEEDED`, token rejection, allowlist or Premium refusal. Retain the deck during every error. Add owner-visible diagnostics: provider refusal, next permissible probe, last successful observation and checkpoint age.

Persist cooldown/backoff and coordinate one request budget and observer per authenticated provider account, with application-level quota coordination where appropriate. Do not assume one process or one run forever. Deduplicate token refresh. Resume jobs safely after refusal; cancelled jobs and user commands must not automatically replay non-idempotent writes.

## 2. Secure identity across devices

Introduce authenticated account ownership/device pairing. Require proof of the provider identity via OAuth or an authenticated pairing flow. Preserve existing local users, encrypted accounts, library snapshots, runs, selections, history, presets, exclusions and rule origins. Multiple preexisting local users connected to the same provider need an explicit deterministic conflict-resolution path; no silent history merge or reassignment. Test foreign-run access remains 404 and revoked devices cannot regain access.

## 3. Persistent observer and session state

Model audible playback, active logical session, parked/paused session, manual takeover and observer availability separately. Keep one canonical logical session ID and one controller lease per provider account. Parked sessions survive inactivity, server shutdown and missing devices. The observer can adopt provider-side resumption only with convincing expected track/context/session evidence. Unrelated Spotify listening must not be commandeered. Enforce configured manual-use policy while recognising expected resumed context automatically.

A persisted checkpoint includes session/card/track, exact latest observed offset, observation time/source, output/context and confidence. Monotonic max listened/eligibility evidence remains separate from last offset. A backward seek updates the checkpoint but never erases heard evidence. Missing device/204 cannot clear checkpoint or consume a card. Compare-and-swap / idempotent transitions prevent concurrent observers, browser commands and reconnects consuming twice.

## 4. Queue horizon and cycle continuity

Maintain a durable ordered plan with a replenish-able provider projection. Provider queue/helper playlist is an execution projection, not the source of truth. Confirm writes before marking the projection committed; repair from the stored plan after failure without duplicate appends. Advance only from observed ends, explicit skips or the configured played/skip contract. Partial songs remain resumable. Account for missed history with timestamp/event deduplication and bounded catch-up; uncertain gaps are visible, not fabricated completed songs.

Renew rolling horizons/cycles under the same session identity. Preserve user rules, discovery suggestions, favourite weighting, similarity spacing, exclusions and history. Define exhaustion/repeat behaviour honestly for no-repeat mode. Do not discard a 1,500-song source because the next provider window holds only 50/250 tracks.

## 5. Home Assistant / Music Assistant

Verify actual HA and MA versions, player IDs, providers, supported commands and event semantics. Evaluate two explicit routes:

- Spotify Connect plugin: advertise MA targets, wake/transfer if supported, resume expected context, confirm it is visible in `/me/player` and responds to commands.
- Native MA queue adapter: enqueue/project the canonical True Shuffle plan through MA's supported API; map provider track URIs; subscribe to playback/queue events with authenticated access; persist positions and reconcile disconnect/restart. Do not let both Spotify and MA controllers fight for a player.

Scope credentials to the needed local service, protect tokens, check ownership and CSRF/replay protections. Surface target reachability and the chosen playback route. A standard HA Spotify integration is not evidence that native MA queues are tracked.

## 6. Acceptance scenarios

| Scenario | Required evidence |
|---|---|
| Leave car at 1:42; resume next day in Spotify | Same session ID/card/plan/history; uncompleted song not consumed; last observed offset or clearly stated replay-from-start fallback |
| Pause in True Shuffle, later Spotify Play | Observer detects matching resumed context and continues without creating a session |
| Natural interruption/204/no device | Checkpoint retained; no timer-based consumption; recovery after long inactivity |
| Switch to another browser/phone | Authenticated identity sees same session and controls current output; unrelated user cannot |
| Device transfer | Follow output; never send commands to stale car device or silently transfer audio back |
| Server/process restart | Persisted checkpoint/lease/cooldown/plan survive, no duplicated events or commands |
| Seek backwards then stop | Latest offset is saved separately; heard eligibility remains monotonic |
| Unrelated Spotify track / ambiguous matching song | Preserve queue; honour manual policy; do not hijack by track ID alone |
| Native Spotify skip / next / track end | Exactly one transition under concurrent command/poll; custom skip/threshold policy respected |
| 429 Retry-After=120 | No request in forbidden interval across jobs/users/endpoints/processes; accurate message and preserved plan |
| QUOTA_EXCEEDED | Shared durable breaker; no reset-time promise; existing helper playlist usable through Spotify if available |
| MA Spotify Connect target | Actual transfer/start/pause/resume and offset observation with named target |
| MA native queue target | Reconciliation via MA events/checkpoints, Spotify observer not double-driving |
| Playlist changes / rolling horizon exhausted | Existing history preserved, rules respected, refill remains same session |
| Old hidden tab / online return | Fresh state and devices, controls correctly show audible/paused/unknown state |
| UI | New Listening Room maintained on 320/390/768/1280/1440, light/dark; keyboard, touch, errors and long names |
