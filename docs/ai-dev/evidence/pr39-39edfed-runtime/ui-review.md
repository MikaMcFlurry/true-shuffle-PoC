# Fresh independent UI / storage-error seam review — PR39

- Subject: `39edfed25987525f03d4f94006b12e7e532ea563`, actual PR39 head, diff from integrated/live1.3.1 `2c6118f69c7671ea9efe506377f28d5d0376737b`. Own isolated clone `/workspace/true-shuffle-ui-review-132`. No implementation role, no app edits or remote mutations.
- INDEPENDENCE = FRESH. VERDICT = READY **for the scoped storage-error presentation/RPC seam**. This is not overall release acceptance; root combines backend ownership/Likes findings and comprehensive gates.
- Authority read: AGENTS, mission protected NN-02/04/05/09/11, actual client/API/Worker/UserHub source diff; Mika Red Team skill and independent contract; Impeccable context once, audit and operate references. Handoff/architecture baseline09d772e and old release paragraphs remain historical navigation, not current architecture acceptance.

## Exact changed mechanism

The classifier separates named daily limits from SQLITE_FULL/non-daily storage limits. `UserHub.exclusive` converts a full-disk error to `{ok:false,error:{code:'storage_full',status:503,message:...}}`; actual Worker onError uses the same code/message/status for runtime-level rejection. Worker RPC unwrap preserves status/code/message. Existing ApiError reads those fields. The only `store.ts` change accepts `storage_full` alongside `storage_limit` as a server-provided notice; the existing epoch guard precedes that state update. Ready snapshots remain visible while stale; a later accepted snapshot clears notice/reason. Initial-load failure uses the existing error surface. No new poll, keystroke read, command transition, identity cache, or backend-writing path is introduced by this UI line.

## Independently reproduced evidence

1. `npx vitest run test/worker/storage-limit.test.ts test/worker/storage-limit-userhub.test.ts`: **8/8 PASS**, two files,2.71s. This includes the actual transpiled `UserHub.exclusive` method invoked by its existing test harness: full disk ->503/storage_full with no time; explicit daily limit ->503/storage_limit with reset time; ordinary failure ->500/internal. Evidence `ui/storage-worker.log`.
2. Own additional probe reads the exact callback body of `app.onError` from current `src/worker/index.ts`, registers it with actual Hono and requests a throwing route: SQLITE_FULL, non-daily storage operation limit, named rows-read daily limit, and ordinary exception. **4/4 PASS** (262ms). Real Hono HTTP status/body, not copied classifier logic. This is an extracted handler runtime check, not a deployed Worker/Cloudflare storage fault. Evidence `ui/storage-http.log`, `ui/storage132-worker.review.test.ts.txt`.
3. Own real Preact/Vite/Chromium browser cases on private port8852 with synthetic `/api` responses and synthetic listenerA/B. Accepted run **5/5 PASS**,6.7s, `ui/storage-browser-accepted.log`:
   - **390×844 and1440×1000, day/night**, reduced-motion preference, actual local fonts (no failed font requests), no page errors, no horizontal overflow.
   - First keyboard Tab focuses `Zum Inhalt`; Enter proceeds to content.
   - Ready song/session ->503/storage_full shows full long truthful message with `role=status`, no `Uhr`/`Tageslimit`/`morgen`, retains SongA and usable navigation. Kassetten ->Jetzt does not erase the notice or saved state.
   - Replacing it with503/storage_limit shows the distinct daily message and no unknown-end clause.
   - `Erneut verbinden` with accepted fresh snapshot clears notice; song remains.
   - Cold-start storage_full is honestly visible; retry recovers. A held503 before a real browser `offline` event is fenced by the existing epoch guard; after release and refresh listenerB is current, old error absent. This is offline-epoch fencing plus accountB recovery, **not** a simulated direct concurrent auth/session reset.

Accepted screenshots: `ui/storage-{full,daily}-{390,1440}-{day,night}.png`. Personally inspected phone/day, phone/night, desktop/day and desktop/night captures. The long notice wraps and remains readable; desktop notice stays at the viewport bottom. Mobile full-page captures show fixed navigation at the screenshot's current viewport position, not proof of a persistent overlap defect. No style preference promoted to a finding.

## Release-copy / backend contract

`src/shared/release.ts` now says a manually selected song shortly before the end will continue and never be cut; the same known-limits paragraph admits final-second selections can still be replaced and pause→back/next can still resume. This claim is broader than the documented behavior. Root/backend reviewer independently reproduced the protected manual-playback violation; attach the overclaim to **B9341-02**, rather than inventing a separate cosmetic wording issue. Adjusting copy alone cannot close the functional blocker. No backend-readiness verdict is inferred from this scoped UI pass.

## Impeccable / scope

Detector ran once on the changed client store file: `ui/impeccable-detector.json` = `[]`. No CSS/token/component visual changes in this PR. Context reports the already-known stale `.impeccable/design.json` sidecar; it remains historical/navigation-only and was not silently regenerated. No requested new design or unprompted style repair.

## Preserved exploratory attempts and limits

- First browser attempt4PASS/1FAIL: fifth **test** called nonexistent `store.reset`; this was a review-fixture author mistake, not an app finding. Log `ui/storage-browser.log` retained; corrected the fixture to dispatch the actual browser offline event (existing epoch guard), unchanged application.
- Corrected run5/5PASS (`storage-browser-final.log`) initially returned an invalid synthetic `/api/native/devices` shape and rendered a handled fixture-warning. Final accepted run fixes only that mock response to `{configured:false,devices:[]}`; warning absent in accepted screenshots. `storage132.before-native-fixture.ts.txt` preserves the earlier fixture. No app edits.
- Root owns full typecheck/lint/build/unit/Worker155browser suite, all dependency/completion metadata, target integration and deployment decisions. These tests do not establish actual Cloudflare disk-full recovery, provider quota/latency/crossfade, physical iPhone/Safari/PWA, privateHA/MA, or populated production restore/rollback-forward. Those remain **NOT_RUN**.
