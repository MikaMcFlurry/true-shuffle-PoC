# PR30 UI re-review at 9e8d

VERDICT: NOT_READY. INDEPENDENCE: FRESH (independent original reviewer, no application edits).
Exact subject: 9e8d1a0ebb1ffee96d7bc3f71141e561a0dcf9f5 at /workspace/pr30-recheck-9e8d. Compared actual selection/import UI changes since ce0dad6; AGENTS and previously loaded independent-review/Impeccable contracts apply. No production or external actions performed.

Executed actual current Preact SelectionScreen/CSS in Linux Chromium with an isolated Vite4199 and intercepted synthetic API. /tmp/pr30-9e8d-ui-harness.mjs and /tmp/pr30-9e8d-ui-results.json retain executable reproduction and outputs. This is a real browser render/API-request ordering probe, not real Worker/provider or physical iPhone acceptance.

## PR30-UI-PREVIEW-FENCE: PARTIALLY_FIXED, still P2 blocking

New draft+revision key fixes one part: after editing a draft, apply is disabled pending its preview; after preview503, apply remains disabled and “Für deinen aktuellen Entwurf gibt es noch keine Vorschau” is displayed. Independently reproduced both states.

Unfixed search/bulk part: completed Alpha-only search, held next preview, changed search to Beta, then clicked enabled “Alle 1 Treffer ausschließen”. Actual current draft excludes Alpha ID aaaaaaaaaaaaaaaaaaaaaa while search input is Beta. Old query's matchIds remain actionable. Current apply is correctly disabled after this incorrect draft mutation; no POST was submitted in this recheck case. Thus original wrong selection mutation persists, but original immediate unpreviewed apply is now repaired and must not be reported as still failing.

Source: selection.tsx draftKey123 only includes draft/revision, previewed227 excludes query; bulk668–692 has no freshness disable and reads previous preview matchIds. Bind browse actions to matching query/group/dataset/revision independently of count preview; show honest pending stale state. Required regression: Alpha→Beta delayed query, grouping/filter changes, bulk IDs asserted; preview failures/retries and out-of-order replies. Retain successful current-draft apply fence assertions.

## PR30-UI-PENDING-DRAFT-LOSS: OPEN, P2 blocking

Draft Alpha and finish preview. Hold apply acknowledgment, click apply. Click still-enabled exclude Beta during pending. Both rules visibly present. Release acknowledgment: Beta silently disappears, leaving applied Alpha only. Exact before/after strings and browser POST payload captured in results edit-during-apply. selection.tsx apply236–265 still sets snapshot draft in acknowledgment (setDraft243); rule editing remains enabled.

Disable mutable draft controls throughout apply/toggle or retain post-request edits via generation fence. Regression: row/bulk/period/remove edits during apply/toggle held acknowledgments; success, error,409 and late ACK preserve later edits or disallow them visibly. This is actual user draft loss, not a style preference.

## Render/accessibility confirmations

Fresh four captures390x900/1440x900, light/dark with extremely long titles/artists. All four personally inspected: no horizontal overflow, all input/select labels present, every measured button/input/select>=44x44, no application pageerrors. Keyboard Enter opens deletion confirmation and cancellation works in every case. Files /tmp/pr30-9e8d-selection-{390,1440}-{light,dark}.png; metrics in results JSON. Mechanical detector output /tmp/pr30-9e8d-ui-detector.json is retained separately, not automatic defect evidence.

Changed import-start UI source inspection: starts a new server import before sending totals, passes start only to first chunk; catches failed start/chunk and returns to ready; event save receives completed totals upload ID. No new import-start UI defect established. Independent browser upload/start-error/whole-App navigation/account switch/live provider flow NOT_RUN in this targeted harness; parent canonical e2e supplies distinct realWorker/FakeSpotify integration evidence.

Limits: full font assets/App shell navigation, backend storage/deletion/import generation, physical iPhone/liveSpotify latency/quota, privateHA and populated production restore NOT_RUN here. No WCAG contrast certification, deployment approval or overall protected-backend verdict implied. Parent should preserve all functional assertions and require final-head re-review of these two fixes.
