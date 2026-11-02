Independent usage/history analysis — INDEPENDENCE = FRESH. The bounded simulated measurements reproduce correctly; they do not establish production viability or Spotify quota recovery.

Subject: `test/hub/usage-audit.test.ts` SHA-256 `1396f1c01fac222bbd5be3bd9afb240c1514de499672b505c7cab7a1697418a5`, application source `b64e03c09569bb4b763980ebdb6d0d5c78e5d263`. Backend/core/shared/native hashes match the prior independent source review. No application edits or production operations were performed.

The independent run copied the audit into an isolated test file, redirected its artifact and added actual simulated-clock assertions. It passed in 7.68 seconds and reproduced these HTTP-request totals; every measured interval was exactly 24 hours:

| Profile | One account measured | Three accounts arithmetic | Five accounts arithmetic |
|---|---:|---:|---:|
| paused_closed | 856 | 2568 | 4280 |
| four_hours_visible_then_paused_closed | 2015 | 6045 | 10075 |
| four_hours_closed_then_paused_closed | 1748 | 5244 | 8740 |

Endpoint-count sums equal the totals, and paused-window counts equal total minus playing-window counts. Setup imports, two hours of warmup and initial Play precede the measurement; the pause/sync boundary is included. The visible/closed listening profiles each contain four hours playing plus twenty hours paused with the app closed. This is a post-setup day, not an onboarding day. Background discovery and maintenance are included.

Each total includes 24 token-refresh calls to `/accounts/api/token`: Web API-only totals are 832, 1991 and 1724. These are transport counts, not known provider quota units. The three/five-user columns multiply one isolated deterministic profile; they do not simulate concurrent accounts, real provider throttling, shared Registry contention, HA/MA traffic or request retries under failure. Different libraries, activity and other development apps can alter usage.

History source is two-stage: player and recently-played observations feed durable SQLite history, and `history()` reads that archive without Spotify HTTP. The test verifies existing archive entries remain readable and unchanged while ordinary Spotify updates stop during a known 30-minute local cooldown. Its one-hub fixture has no shared Registry, so it proves all endpoint suppression for the audited account, not a new cross-account production proof. Imports/native listening are distinct feeds. Full catch-up after a long outage is unproven: current `readRecent` reads one recently-played page with limit 50, so the test must not promise recovery of every unseen play during an eight-hour restriction.

The local gate intentionally blocks all Spotify endpoints conservatively. Spotify documents shared developer-account development-app quota and endpoint buckets whose membership/limits may change. A devices quota response therefore triggers the application's global policy; it does not prove Spotify's recently-played endpoint belongs to the same exhausted bucket. No available published number/window establishes whether three or five users fit. Testing a separate developer account can investigate the documented sharing boundary, but neither account creation nor success/recovery is established here.

Evidence: `/tmp/ts-full-day-usage-audit-independent.log`, `/tmp/ts-full-day-usage-audit-independent.json`; modified independent test `/tmp/mika-independent-review/test/hub/usage-audit-independent.test.ts`. Generated 2026-09-30T11:05:11.518025+00:00.

The final analysis document explicitly records these limitations, and the audit flag is now scoped as `deviceQuotaStopsAllEndpointsForAuditedAccount`. This naming-only correction does not change the independently reproduced counting behavior.
