# Fresh independent UI/account/test-harness review — PR36 / 1.3.1

- Subject: integrated `2c6118f69c7671ea9efe506377f28d5d0376737b`; comparison application baseline `9341e0d3305778210adbf89e165ec3f66459a956`.
- Isolated checkout: `/workspace/true-shuffle-ui-review-131`, detached exact SHA. No application-source change. Only untracked independent test/config files added here; copies retained as `.ts.txt` under `ui/`.
- INDEPENDENCE: FRESH. No implementer role; reconstructed diff and independently executed runtime probes.
- Scoped verdict: READY. No open blocking UI/account/test-harness finding discovered. This is scoped UI repair acceptance, not overall release/worker/production acceptance.
- Date UTC: 2026-11-08T16:34:29.853763+00:00

## Direct checks

1. `PR35_OUT=/workspace/review-evidence-131/ui npx playwright test -c e2e/review/pr35.config.ts`: **7/7 PASS** (15.4 s), actual Preact/Vite/Chromium with synthetic API routes. `ui/pr35-browser-fonts.log` is the accepted run.
   - A→B held A search: requests `[A,B]`; B renders only `Alice for B`, never A private listening.
   - Signout→same A re-login: fresh `[A,A]`, old session result excluded.
   - Controlled/fixed devices across day/night and widths 320/375/1280: day contrast **12.579:1**, night **14.891:1**, horizontal overflow 0. Long device name tested. Correct actual fonts served in accepted run.
2. Added independent long-title/long-device tests at **390×900 / 1440×900, day/night**, reduced motion; Home→History search→Home navigation, first keyboard Tab `Zum Inhalt`, Enter, named searchbox, navigation targets at least44 px, no horizontal overflow, no page errors or failed font responses. **4/4 PASS**; log `ui/independent-browser.log` includes repeated original7+extra4 =11PASS (17.2 s).
3. Added adversarial pending response cases: A request held, B signs in; late A **503/error message** suppressed and B own result shown; same A request held while History closed, account changes elsewhere, reopening requests B, A private result suppressed. Exactly2requests `[A,B]` in both, no keystroke backend loop. **2/2 PASS** (3.3 s), `ui/adversarial-browser-retry.log`.
4. `npx vitest run test/client/history-search.test.ts`: **11/11 PASS**, log `ui/history-search.log`.

5. Additional degraded state probe **1/1 PASS** (3.2 s): pending request shows skeleton/no false hits; aborting its network request renders honest named offline alert, navigation away/back and fresh search recover to own result, exactly2search requests. `ui/degraded-browser.log`; `pending-search.png`, `offline-search.png`, `recovered-search.png`.

## Actual diff / mechanism

`HistorySearch.load` fences both cache and in-flight request by account; generation increases on `forget`/account changes. Update merge copies the songs map, so an old update cannot mutate a previously published cache map after signout. Old request finalizer only clears the matching promise. `menu.tsx` clears the cache from existing ratings-account-generation subscription even when History is closed. Rendered hits/error carry `account:generation`; effect completion checks current generation and response account. Search and errors are excluded immediately on render when the generation differs. Existing per-session cache and request coalescing remain.

`VolumeKeys` only changes percent whitespace to NBSP. CSS adds the existing dark-bay foreground to `.walkman .volume__value`; readback verifies day/night rather than inferring token contrast. Noncontrollable-device case also passes.

`e2e/history-ratings.spec.ts`: substantive interaction/assertion bodies retained; new isolated `e2e-ratings` synthetic listener, restored `mika` in afterAll, selection from newest40 plays, extra account/≥14candidates/page60-position assertions and10row margin. The two removed lines are old seed selection/unique derivation, not functional assertions. `e2e/fake-server.ts` preserves mika playlist slices/order/IDs and liked-ID expression; device objects are independent copies. Newly created listener has one title per playlist entry to avoid display-name ambiguity. Test runner is serial (`workers:1`, `fullyParallel:false`), so global synthetic listener selection is not concurrently shared by specs. Full Worker/FakeSpotify suite belongs to root verification, not claimed from this scoped fixture.

## Visual inspection and Impeccable

Personally inspected current captures: `ui02-day-320-page.png`, `ui02-day-1280-long-page.png`, `ui01-another.png`, and all4 `independent-{390,1440}-{day,night}.png`, plus `offline-search.png`. Long content wraps; repaired device/volume line is readable; controls and navigation remain legible and reachable. Full-page screenshots include fixed bottom navigation at its current viewport position; this is not evidence of a persistent overlap defect.

Read AGENTS and Mika Red Team / independent-review contract; loaded installed Impeccable context and audit/operate references. Detector ran once (`ui/impeccable-detector.json`,45whole-file flags). Existing mechanical border/font/style warnings are outside the repaired5line CSS/whitespace changes and do not establish functional faults; decorative key borders are the explicit incumbent brief. No style preferences promoted to bugs. Impeccable sidecar stale remains historical/navigation-only; no app change or sidecar regeneration.

## Limitations / preserved failed attempts

- First7/7run used symlinked dependencies: Vite rejected font files outside serving allowlist. It is **not** accepted visual evidence. Copied deps locally and reran cleanly; accepted log `pr35-browser-fonts.log`. Initial log retained honestly.
- First extra adversarial invocation had overly anchored grep and found no tests; corrected invocation ran2/2PASS. Initial `adversarial-browser.log` retained, no app repair needed.
- Synthetic routes establish client race/render behavior only; physical iPhone/Safari/PWA, actual Spotify latency/quota/transport, privateHA/MA and populated production restore **NOT_RUN**. No production writes/authenticated live journey performed.
- Backend continue-after/likes/storage findings are a separate independent review; overall release verdict must combine them with root gates and exact source/deployment revalidation.
