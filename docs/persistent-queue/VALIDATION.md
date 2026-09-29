# Verification boundary

## Functional checks

- Full Python application suite: **752 passed, 8 deselected**, 2026-09-29. Optional slow property tests and browser suite are intentionally excluded from that default command.
- Lint: `.venv/bin/ruff check .` passed; `git diff --check` passed.
- New backend regressions: process-wide cross-endpoint 429 cooldown; long Retry-After; QUOTA_EXCEEDED suppression; persisted old unfinished song resumed at 42 seconds without changing cursor/order; quiet idle/drift polling.
- Existing restart, history, queue strategy, custom rules, exclusions, API ownership and lifecycle regressions remain in the passing default suite. Those tests use fake/demo/stubbed providers, not live Spotify.

## Browser checks

- Repaired critical flow, touch targets, keyboard and reduced motion: **17 passed**.
- New continuity UI checks: **3 passed** (live watcher without playback evidence never produces a Pause button; Space on exclusions retains native action and sends no playback command; pageshow refreshes devices).
- Final combined browser subset: **29 passed in 200.30s** (critical flow, overflow, touch, contrast, keyboard, reduced motion and continuity UI).
- Earlier batched contrast and overflow checks passed. The first batch had three failures: an obsolete caption expectation, a long-state-banner transport fold failure, and an obsolete Aurora animation expectation. The caption now reflects the redesigned queue region; messages follow transport so its controls remain reachable; the calm home surface intentionally no longer animates decoratively.

## Visual review

- Dark desktop at 1440px, dark mobile at 390×844 and light mobile captured under `screenshots/`.
- Main button measured y=580–652 in the final phone capture, within the 844px screen. Error/state messages are placed after controls to preserve reachability.
- Independent Impeccable finish reviewer: **ship for reviewed UI scope**, its listed playback inference and focused-control keyboard findings resolved. This is not a product-wide live verification claim.
- Detector ran once and returned no regex findings but explicitly reported DEGRADED mode (missing parser modules). It does not establish computed contrast, selector correctness or full accessibility coverage; browser checks provide their own evidence.

## Not verified / not implemented

No deployed Spotify session, actual provider quota response, Spotify-side resume after a True Shuffle pause, paired second-browser owner identity, native MA queue or HA instance was tested. No production database migration or release deployment occurred. Cooldown remains process-local. Saved checkpoint is polling-based and uses existing monotonic observed progress; exact backward-seek offset needs a separate checkpoint. Existing user-played thresholds remain authoritative. See ANALYSIS.md and IMPLEMENTATION_PLAN.md.

Impeccable remote download/update failed at its signed-bundle host. The installed project copy is the available bundled 4.1.2 skill, not a claimed successful remote update.
