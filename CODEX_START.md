# True Shuffle: start here

Continue on branch `codex/persistent-queue-redesign` in `MikaMcFlurry/true-shuffle-PoC`.

## User outcome

True Shuffle is an indefinitely resumable listening session. Close the tab, leave the car, pause for days, switch phones/speakers, or press Play in Spotify: the SAME session, queue, heard history, preferences and unfinished song survive. Prefer the last observed minute; if unknowable, replay the unfinished song, not a newly shuffled queue. Preserve working discovery/suggestions, playlist resurfacing, custom rules, favourites and exclusions. Spotify audio stays in Spotify. Support Home Assistant / Music Assistant deliberately rather than assuming every media_player is Spotify Connect.

## Read before editing

1. `docs/persistent-queue/ANALYSIS.md` — code evidence, changes already implemented and explicit remaining gaps.
2. `docs/persistent-queue/IMPLEMENTATION_PLAN.md` — ordered work and acceptance scenarios.
3. `docs/persistent-queue/VALIDATION.md` — exact current checks and limits.
4. `PRODUCT.md`, the new `DESIGN.md`, and `docs/persistent-queue/DESIGN_DIRECTION.md`.
5. `.agents/skills/impeccable/SKILL.md` and `docs/persistent-queue/IMPECCABLE.md`. The owner explicitly chose a calm dark music-player direction. Do not revive the old Nachtpult/Laufzettel identity.
6. Existing architecture decisions in `docs/`, current schema/migrations, security and lifecycle tests. Older STATUS/README claims are historical unless reverified.

## Execution rules

Implement and verify the remaining work end-to-end. Do not stop at another analysis document. Back up production SQLite and preserve SECRET_KEY before any real migration; never print tokens or credentials. No dropping/rebuilding existing user history. Account pairing must be authenticated and tested for isolation, not an ownership bypass. Treat migrations, background tasks, one-driver-per-account, progress evidence, provider rate limits and queue identity as one system.

Reuse this branch's tested fixes and new visual system. Check actual Spotify HTTP status, reason and Retry-After plus aggregate request counts; no invented quota reset time and no Client-ID cycling. Extend the cooldown to persistent shared storage. Unknown positions stay unknown; never mark tracks heard using only a clock. Separate paused/parked/observer/controller responsibility from task liveness.

For HA/MA, inspect actual versions and capabilities via operator-provided access. Implement either verified Spotify Connect handoff or a native MA adapter with event/checkpoint reconciliation. Document precisely which devices/routes work and which are blocked. Do not report universal HA support from a single Spotify test.

Run Python tests, lint, browser desktop/mobile/light/dark/accessibility checks, then live Spotify and HA acceptance scenarios. Update validation with direct evidence. Open/update a reviewable PR; do not merge or deploy production without an explicit release instruction. If a live dependency is unavailable, complete all independent implementation and identify the exact missing access; do not label simulated results live-proven.
