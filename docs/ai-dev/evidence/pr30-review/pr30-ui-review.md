# PR30 independent UI review

INDEPENDENCE: FRESH. VERDICT: NOT_READY.
Subject: application source a247910b596266c785c3d30e3f1d18c4465e9064, baseline 8d62138184be9397ea22d55170928a4edbbc0725. Parent reports c27301400b0588e49a7f1d1671aad8f4836343a6 changes only e2e/evidence, application byte-identical; parent must bind this report with that comparison. Reviewer made no application edits or external comments.

Read AGENTS.md, Impeccable skill/context/audit and Mika Red Team skill/independent contract. Reconstructed actual SelectionScreen and API handlers; did not accept builder descriptions as evidence. Impeccable design-sidecar stale is pre-existing context metadata and not a material application defect.

Runtime: actual Preact SelectionScreen and committed app/mehr CSS, Linux Chromium, isolated Vite4199; intercepted API returns representative synthetic data and delays/errors. This harness does not assert real backend/provider outcomes. Test-only mounted harness at e2e/.artifacts/pr30-ui-harness.tsx, executable /tmp/pr30-ui-harness.mjs, results /tmp/pr30-ui-harness-results.json. Initial harness mounting failures were environmental (duplicate Preact; Vite /api proxy swallowed /api.ts module), corrected before results below. No application pageerrors in final captures. HMR socket console messages are test-server environment messages.

## Blocking findings

PR30-UI-PREVIEW-FENCE — P2 blocking, src/client/screens/selection.tsx preview effect175–192, apply button542 and bulk search626–656.
1. Load two tracks Alpha ID aaaaaaaaaaaaaaaaaaaaaa and Beta ID bbbbbbbbbbbbbbbbbbbbbb.
2. Search Alpha and let its preview finish (one match).
3. Hold subsequent POST /api/history/selection/preview response, replace search with Beta.
4. Click enabled “Alle 1 Treffer ausschließen”; click enabled “Auswahl übernehmen” before fresh preview resolves.
Actual: search input is Beta, draft and real browser-submitted POST /api/history/selection rules exclude Alpha ID aaaaaaaaaaaaaaaaaaaaaa. Old matchIds and counts remain actionable while query/draft have changed. Independently, returning503 “Offline Vorschau” for changed draft leaves apply enabled on old counts. This violates explicit inspect/preview-before-apply and lets bulk action target a previous search.
Expected: invalidate or mark stale preview on draft/query/import/revision change; gate bulk targets and apply on a successful response matching current draft/query/dataset/revision. Retaining stale display is acceptable only with honest pending status and disabled incompatible actions.
Needed regressions: slow search Alpha→Beta; query/group changes; delayed out-of-order previews;503/offline new draft cannot confirm using stale counts; retry obtains correct counts and targets. Check actual submitted IDs, not only text.
Direct evidence: results cases stale-search-bulk and failed-preview-apply include posted payload/enabled state.

PR30-UI-PENDING-DRAFT-LOSS — P2 blocking, src/client/screens/selection.tsx apply223–252 and still-enabled rule controls.
1. Draft exclusion Alpha, allow preview finish.
2. Hold POST /api/history/selection acknowledgment, click “Auswahl übernehmen”.
3. While pending, click still-enabled exclusion Beta. Both exclusions appear in draft.
4. Release Alpha-only apply acknowledgment.
Actual: setDraft(v.selection) silently replaces later edited draft; Beta disappears. Submitted payload contains Alpha only. Same captured closure pattern applies to toggle draft reset.
Expected: either disable rule-edit controls throughout mutation or retain post-request edits with a draft generation fence; no later user edits silently discarded by acknowledgment. Applied state can update independently of newer draft.
Needed regressions: edits/add/remove/bulk during held apply/toggle; success/error/conflict acknowledgments; no lost newer draft and honest applied-versus-draft status.
Direct evidence: edit-during-apply before includes Alpha+Beta, after Alpha only; POST captured separately.

## Verified positive scope

Four actual full-page renders:390x900 and1440x900, light/dark, two extremely long track titles and artist names. Viewed all four PNGs; measured no horizontal overflow, every input/select labelled, every button/input/select target>=44x44. Responsive stacked mobile rows and desktop side actions remain readable. Keyboard Enter opens deletion confirmation and Enter cancellation removes it in all four cases. Pending/error cases reproduced above. Existing integer revision conflict handling retains draft on rejection by source inspection; parent comprehensive realWorker/FakeSpotify browser checks supply integrated navigation/delete coverage, not independently re-executed by this reviewer.
Captures: /tmp/pr30-selection-390-light.png,390-dark.png,1440-light.png,1440-dark.png. Mechanical detector: /tmp/pr30-impeccable-ui-detector.json: [] (no mechanical findings).

Limits: full App navigation/account-switch lifecycle, real Worker/database, live Spotify quota/latency, physical iPhone, privateHA and populated production restore NOT_RUN in this targeted harness. No full contrast/WCAG certification. No production merge/deployment acceptance is implied. Preserve parent functional tests; fresh review must reproduce fixes at final application SHA.
