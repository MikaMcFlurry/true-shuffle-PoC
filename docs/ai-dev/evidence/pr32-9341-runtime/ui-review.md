# Independent UI/client review

SUBJECT = `/workspace/true-shuffle-review-9341`, detached `9341e0d3305778210adbf89e165ec3f66459a956` (PR #32), compared with `26371042`.
INDEPENDENCE = FRESH. This reviewer did not implement the changes, independently inspected actual source, wrote adversarial tests in isolated detached worktree `/workspace/true-shuffle-ui-review-9341`, and ran the actual Preact client with synthetic API responses on private port 8841. Author claims and committed screenshots were not accepted as evidence.
VERDICT = BLOCKED.

Scope: history search and account lifecycle; new volume, continue-after, likes and Spotify fallback client components; narrow responsive/accessibility/theming review. Root reviewer owns full gates and real Worker/FakeSpotify browser suite. No application source edits, GitHub writes or deployments were made by this reviewer. Skills applied: Mika Red Team and Impeccable audit. Severity uses the Red Team release contract.

## Open findings

### UI-01 — P1, blocking: delayed search response discloses the previous account's listening history

Affected source: `src/client/history-search.ts:64-82`; `src/client/screens/menu.tsx:441-467` and module singleton at line 609.

Precondition: account A's history-search request is still pending while the same loaded app obtains account B's state (a supported account-change lifecycle). This can occur across an account/session change while an already issued response is delayed. No cross-account server access is needed.

Deterministic reproduction against actual module:

1. Construct `HistorySearch` with a deferred fetcher.
2. Call `load("A")`, then `load("B")` before resolving A's response.
3. Resolve with A's private song.
4. B's promise resolves with `index.account === "A"`, containing A's song. The fetcher was called only once.

Browser reproduction (`e2e/ui-review.spec.ts` in isolated worktree): intercept actual client `/api/state` with account A, hold `/api/history/search`, open `/verlauf` and enter Alice. Change the state fixture to B, request an actual `store.refresh(true,true)` through the Vite-served store module, let B's effects settle, then release A's search response. The active state is B, only one search request was sent, and `.hist-hit` renders `Alice private listening`. This is a test fixture driving the actual client, not a real OAuth/provider session or a backend isolation test.

Expected: B receives only B's search data; late A responses cannot populate B's rows or rating knowledge.
Actual: `load()` checks the cached index's account, then unconditionally returns any in-flight promise. The B effect holds B's current ratings generation, so its generation check passes when A's index arrives. It never verifies `index.account`. It also feeds A's rows into B's `takeListed`, which can contaminate displayed rating knowledge. The independent module reproduction also confirms `forget()` does not invalidate a pending request; its late resolution repopulates the supposedly forgotten cache. `forget()` has no caller in the app.

Evidence: `search-race-unit.log` (2/2 adversarial regressions fail), `ui-browser.log` (`CROSS_ACCOUNT_DISCLOSURE`, exploit assertion passes), `account-race-mobile.png`, and the archived test files alongside this report.

Repair direction: bind pending work and cached results to account plus session generation; invalidate both on sign-out/account changes, fence late commits/finalizers, and reject an index whose identity does not match the consumer. Reset hits/errors when identity changes. Require regression coverage for overlapping A/B loads, sign-out/in as same account, forgetting during load, and a rejected/late old request while a newer account loads. Preserve one-request/coalescing behavior within a single identity.

### UI-02 — P2, blocking accessibility/theming: device volume readout is effectively invisible in day mode

Affected source: `src/client/components/volume.tsx:52`; `src/client/styles/app.css:2662` (volume value styling) and `.walkman .transport` at line 1395.

Precondition: day/default light theme and a Spotify observation exposing controllable volume. The new label is rendered in the dark transport bay.

Reproduction: serve actual client with `ts-illumination=day`, observed device `{name:"Wohnzimmer Lautsprecher",volume:35,volumeControl:true}`, and open Jetzt. Inspect `.volume__value` and nearest opaque ancestor background. Reproduced at 320px and 1280px.

Expected: the device name and numeric volume remain readable, at least WCAG 2.2 SC 1.4.3's 4.5:1 normal-text contrast.
Actual computed browser colors: text `rgb(42,28,10)` on `rgb(42,33,22)`; contrast **1.046:1** (WCAG relative luminance formula). The 35% and device name are nearly indistinguishable from their background. The plus/minus controls are visible but the user cannot read the volume feedback. Forced night mode is 15.356:1, confirming the day-mode gap.

Evidence: `ui-browser.log` (`VOLUME_CONTRAST_COLORS`), `player-mobile-light.png`, `player-desktop-light.png`, and comparison `player-mobile-dark.png`.

Repair direction: give volume labels an appropriate transport-surface text color in both themes, including the non-controllable explanatory variant. Require computed contrast and rendered day/night regression evidence with normal and long device names. Suggested workflow: `/impeccable harden`, then `/impeccable polish` after the functional repair.

## Bounded Impeccable audit

Implementation integrity: FAIL because account identity is not preserved by the new search cache. The visual system otherwise remains coherent in sampled renders; no redesign/style change is requested.

| Dimension | Score within sampled changed surfaces | Evidence |
|---|---:|---|
| Accessibility | 2/4 | UI-02 fails text contrast; search has explicit label, volume has a legend and labelled buttons, new sampled targets meet 44px |
| Performance | 3/4 | local normalized search, debounce and same-account request sharing; browser race sends one request, no per-key request observed; large-history latency not measured |
| Responsive design | 4/4 | zero document overflow at 320/375/1280px in sampled search/player fixtures; all sampled button/input/summary targets meet 44px |
| Theming | 2/4 | correctly forced day/night renders; volume label day contrast failure |
| Implementation integrity | 1/4 | reproduced cross-account data disclosure |
| Total | 12/20 | Bounded diagnostic score, not whole-product acceptance |

Bundled detector run: `node .agents/skills/impeccable/scripts/detect.mjs --json src/client/screens/menu.tsx src/client/components/volume.tsx src/client/components/continue-after.tsx src/client/components/likes.tsx src/client/components/spotify-fallback.tsx src/client/styles/app.css`; output `impeccable-detector.json`. Its three rounded-border warnings point at existing key-face sides (lines 1411/2453/2506), which are intentional incumbent cassette/key semantics and unchanged by this PR: no release finding. Font-size advisories describe design documentation drift, not independently demonstrated user defects; not promoted to findings. The scanner does not detect the actual account or contrast defects.

Positive evidence: actual rendered search is labelled, grouped by song, expandable to listening timestamps, keyboard reachable with native controls, no observed sideways overflow; volume +/- controls are exactly 44px; armed continue-after displays a labelled cancellation button; fallback Spotify playback asks for deliberate confirmation; Likes error code exposes retry/status text. These last two were inspected in source, not exercised against Spotify by this reviewer.

## Executed evidence and reproduction

- `npx vitest run test/client/history-search-race.review.test.ts` in isolated worktree: **2 failed** as expected for protected account/forget invariants. Captured `search-race-unit.log`.
- `npx playwright test -c playwright.review.config.ts`: **4 passed** (one exploit assertion proving disclosure; three synthetic rendered day/night/width cases). Captured `ui-browser.log` and seven screenshots. Passing exploit tests do not imply readiness.
- Private Vite config imports the subject config and removes its development `/api` proxy (which otherwise matches `/api.ts` module import), allows symlinked font dependencies, and uses only port8841. Fixtures intercept all `/api/**` traffic. No root e2e state/ports touched.
- Review test/config copies are archived beside this report; their imports assume placement at original paths in a detached worktree. Only extra test/config files and a dependency symlink exist in the isolated worktree.
- Full-page screenshots include a fixed navigation bar at the captured viewport position; that rendering alone is not treated as a covered-control defect because the page can scroll past it. Mocked native-device discovery can produce a fixture warning; it is not evidence of a product/provider defect.

Critical NOT_RUN: physical iPhone/device behavior; live Spotify transport, quota, playlist mutation and latency; private HA/MA; populated-storage restore. Chromium fixture screenshots do not satisfy any of those gates. Screen-reader traversal, full theme/design matrix, full likes/fallback error interaction and populated-history search timing were not independently run by this scoped reviewer. Existing author claims do not close them.
