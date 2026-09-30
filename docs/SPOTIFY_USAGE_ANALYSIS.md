# Spotify usage and an isolated test account

The full-day pressure measurement below audits application source `b64e03c09569bb4b763980ebdb6d0d5c78e5d263`. Its numbers remain a historical baseline. The subsequent artist-albums scope correction addresses an overbroad request gate; it does not establish a reduced daily workload or live Spotify recovery.

Spotify does not write to a database shared with true-shuffle. The hub obtains player observations from `/me/player` and listening history from `/me/player/recently-played`, and writes results into its own SQLite `plays` table. `history()` then reads that table. Calling the history screen itself is a database read; new history records can nevertheless be fed by successful Spotify synchronization. The previous explanation that stored history did not demonstrate any Spotify communication was incomplete.

The owner's later screenshot resolves the apparent contradiction: the stored hour contains successful player, recently-played, library and device requests, followed by one actual `/artists/:id/albums` quota response. Subsequent device records have `blocked` status: true-shuffle prevented those requests locally. Fresh history can therefore coexist with a later metadata failure; hourly counts alone do not establish that all other endpoints remain available after that failure.

The corrected gate isolates only a genuine GET `/artists/:id/albums` `QUOTA_EXCEEDED` response. Its exact saved deadline is preserved for that endpoint family. Player, device and history calls retain their own error handling; unknown quota sources and ordinary rate limits remain global. This is an application boundary, not an inferred Spotify bucket map. Manual rechecks target the affected artist-albums source, never a successful player request as proof of metadata recovery.

Old global records retain their saved deadline. Their latest metadata and one-hour counters cannot exclude an earlier general rate/quota error merged into the same gate, even if the current hour identifies only artist-albums quota. Automatic clearing or splitting would therefore risk bypassing another valid provider wait. At the saved deadline the usual deliberate recheck is possible; successful playback does not establish that an independently saved artist-albums restriction has ended. No provider deadline is shortened and no account identity or stored history is replaced. The owner may continue to see the legacy general hold until 20:20 on September 30; the fix prevents recurrence of the artist-albums classification bug for new provider responses.

History synchronization currently reads one recently-played page of up to 50 entries: complete catch-up after a many-hour restriction is unverified. Spotify documents shared development quotas per developer account and groups of endpoints sharing buckets, without a public allowance or reset period. Neither this fix nor the earlier copy correction establishes that Home Assistant's own requests or automations recover. Those integrations and account-wide usage remain unmeasured.

## Full-day measurement

The real HubCore runs against FakeSpotify and SQLite with production alarms, a 1200-track library and three-minute tracks. A two-hour settling period and initial Play are outside the 24-hour measurement. Discovery and maintenance inside the measured window are included. There are no real Spotify requests. The 3/5-user figures multiply one account's measured workload; they are estimates, not a live multi-user capacity test. Other apps, additional commands, different libraries and retries can change the totals.

|24-hour scenario|Spotify calls, one user|Three users, estimate|Five users, estimate|
|---|---:|---:|---:|
|Paused throughout, app closed|856|2,568|4,280|
|4 hours playing with app visible, 20 hours paused/closed|2,015|6,045|10,075|
|4 hours playing with app closed, 20 hours paused/closed|1,748|5,244|8,740|

Each total includes 24 token refreshes. Corresponding Web API requests are 832, 1,991 and 1,724 per account. Do not assume token refreshes use the same Web API quota bucket. The visible-playing scenario produces 510 calls during the four playing hours and 1,505 during the following 20-hour pause: about 75% of calls occur after the player is paused. The wholly paused scenario has a different activity history and therefore a different alarm schedule; it is not interchangeable with the pause after four hours of listening.

The source shows two material leads: `heldPace()` watches a paused station every 30 seconds initially and every minute later; `alarm()` synchronizes before processing jobs, so maintenance wakeups also trigger player observations. Foreground state reads have a 45-second freshness check, but alarm synchronization does not reuse that check. Device-list requests have no corresponding durable response cache. These are stronger optimization leads than the previous short-window 18% result.

Priorities for the next bounded engineering change:

1. Reuse fresh observations across alarm maintenance and foreground requests; do not make a player request solely because another background job woke the hub.
2. Back off non-private paused/idle observation progressively; keep explicit controls responsive. Validate external Spotify resume, private listening, guest boundaries, skip decisions and checkpoint recovery before accepting any slower cadence.
3. Cache device lists per account and refresh on deliberate selection or invalidation.
4. Record bounded hourly actual-provider counts over a rolling day, separated from locally blocked attempts and token refreshes. The current diagnostic retains only one hour, which cannot establish daily usage.
5. Measure user workloads and endpoint categories before choosing an internal budget. Spotify's unpublished allowance cannot be turned into an invented target or a promise of capacity for five users.

## Dedicated developer account

A new app under the existing developer account does not separate its quota. An app owned by a distinct developer account can separate the documented account-level counting from the existing HA/MA apps, but is not evidence that Spotify will grant an adequate allowance. Spotify currently requires the development-app owner to have Premium, and allows up to five authenticated Spotify users who must be allowlisted. These requirements also apply to a new test owner/account.

Use the existing `wrangler.preview.jsonc` configuration for an isolated Worker with its own USER_HUB/REGISTRY namespaces and APP_SECRET. It is not deployed by this audit. Register that Worker's exact HTTPS `/auth/callback` URI in the test Spotify app, configure its Client ID, and authenticate the test users afresh. The app uses PKCE; no Client Secret is needed. Merely replacing the production Client ID would leave old client-bound refresh tokens and the old saved quota gate, and would invalidate a clean comparison. Production histories/queues and existing app credentials must remain in their current Worker.

A useful live comparison measures playback, pause, app closed, devices and commands separately for one, then three, then five users, with the test developer account used only by that app. Record actual successes/429 reasons/Retry-After and counts per endpoint over at least a full day, without retrying during provider deadlines. Only that evidence can establish the remaining live viability; it cannot be supplied by this simulator or by creating an app alone.

Evidence: `docs/ai-dev/evidence/FULL_DAY_USAGE_AUDIT.json`, `full-day-usage-audit.log`, and `test/hub/usage-audit.test.ts`. Run `npx vitest run test/hub/usage-audit.test.ts` to reproduce the observations. Official source: https://developer.spotify.com/documentation/web-api/concepts/quota-modes.

## Explicit partial-function trial

The owner subsequently authorized a test reset of the old local hold. The new authenticated availability action backs up an eligible ambiguous old QUOTA_EXCEEDED record and moves its exact shared hold into a separate application quarantine using revision/probe fencing. It does not claim a Spotify reset or infer an endpoint bucket. Catalog requests, artist-albums and playback control writes retain the old deadline. Identified new general quota, ordinary rate and unknown errors cannot be quarantined by this action.

The trial sends at most one GET each for devices, player status and recent history, with at most one token refresh and no automatic request retries. Rapid repeats use the saved result for one minute. Genuine quota responses on these exact GET families have separate durable holds; general rate/unknown failures stop remaining probes. Results mean that a read answered at the displayed time. They do not establish that playback writes, HA automations or other apps recover. Devices returned by the test are shown without a second provider request.

A held player read no longer prevents independently due recent-history ingestion; the fallback preserves the last player snapshot and saved session/checkpoint exactly. A held history read likewise leaves player observations available. Recorded observations do not infer queue completion from elapsed time or missing data.

Account-owned diagnostics now keep up to 24 hourly aggregate buckets starting with new observations. Actual provider attempts, token refreshes, locally blocked calls and the first genuine quota response in each hour are distinct. This is partial measurement until enough time elapses; Spotify allowance and bucket grouping remain unpublished. Historical856/2015/1748 counts remain a pressure baseline, and this experiment does not establish reduced steady-state demand or sustainable capacity for three/five users. Real owner trial results must be collected after deployment using the owner's authenticated action; they are not supplied by local fixtures.
