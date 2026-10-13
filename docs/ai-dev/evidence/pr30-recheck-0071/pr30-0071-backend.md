# PR30 independent backend continuation/CAS review

INDEPENDENCE = FRESH. Distinct read-only reviewer; no participation in implementation. Separate clean detached worktree `/workspace/pr30-backend-0071`; subject `0071c76aeac663d670ec39dcc37aedf2a5df80f3`. Reviewed actual functional delta from `9e8d1a0ebb1ffee96d7bc3f71141e561a0dcf9f5`, plus retained earlier import generation/delete contracts. Baseline application target remains `8d62138184be9397ea22d55170928a4edbbc0725`.

VERDICT = READY narrowly for this inspected backend repair delta. Full release remains BLOCKED by inherited PR24–29 findings, absence of Claude release-scope completion, draft status and unavailable authenticated deployment access; UI verdict is a separate reviewer/coordinator responsibility. This report does not close inherited findings or claim deployment/live acceptance.

## Actual repair and adversarial conclusions

- Required totals continuation identity: hub6265–6272 now checks every later block's upload id, exact expected position and total parts. Independently verified old/unnamed/empty/foreign ids with the exact expected second-block position cannot join the current upload or mutate staging. Correct current id completes, restart preserves fences, completed upload cannot append. An unfinished upload superseded by a one-block import cannot finish afterward. Earlier deletion epoch and named individual-listen generation fences remain effective.
- Required selection dataset CAS: hub6668–6681 rejects missing/invalid id as400 and changed stored totals or listen generation as409 before same-selection early return or mutation. Synchronous real HubCore calculation has no async interleaving between dataset check/materialization; UserHub wraps all these operations in its existing per-listener exclusive/session check. Added preview dataset identifies the stored import actually calculated. Independent probe adds individual listens to the same totals id, restarts, and proves a previously previewed selection is rejected while a fresh one works. Totals replacement/deletion and unchanged-selection identity checks also pass existing inspected regressions.
- Another listener's dataset identity cannot be substituted at HubCore; own selection leaves the other harness's memory/revision untouched. This is an in-process semantic fence test, not a new production authentication acceptance claim.
- Worker forwards dataset into the same authenticated session-bound RPC; existing /api/* custom-header CSRF and signed-session middleware remain unchanged, as do hub identity routing, session epochs and exclusivity. No new unauthenticated entry or new secret/binding/class/migration change in this delta. No changes to scheduler, native/guest transport, observed progress/queue occurrence, endpoint429 or visual clock infrastructure in the inspected repair.
- Existing functional assertions are retained: changed legacy direct callers now supply the required dataset/upload ids instead of deleting protected invariants. Existing tests cover live memory/thumbs/bans/queue/stations/discoveries preservation, additive SQLite schema restoration, selection planner/genre effects, replay/profile and playlist incomplete/403/429 handling.

## Direct executed evidence

1. `npx vitest run test/hub/pr30-independent-original.test.ts test/hub/review-blockers.test.ts test/hub/history-selection.test.ts test/hub/selection-ranking.test.ts test/hub/session.test.ts test/hub/playlist-counts.test.ts`: **71/71 PASS**,6 files,7.10s,default timeouts. `/tmp/pr30-0071-backend.log`. Original three prior review expected-contract probes preserved except supplying now-required current dataset id in the valid apply call; `/tmp/pr30-0071-original-repros.test.ts`.
2. New independent adversarial probes described above: **3/3 PASS**,859ms,default timeout. `/tmp/pr30-0071-independent-cas.test.ts`, `/tmp/pr30-0071-independent-cas.log`.
3. Same unmodified new probes run against independently detached older9e8d source: **3/3 FAIL** (expected negative control; missing CAS, unnamed continuation accepted),1.47s. `/tmp/pr30-0071-independent-baseline.log`. This establishes sensitivity to the actual repaired contracts rather than accepting builder-authored passing evidence. That baseline's SelectionPreview lacked dataset; the same supplied payload is accepted there, which is the defect under test.

These are simulated fixture tests with real HubCore/nodeSQLite/FakeSpotify. No real Spotify calls or user data. Temporary in-repo tests removed after runs; reviewed application remains unmodified. Node_modules symlink is the only untracked item in each reviewer checkout. Coordinator owns full build/type/lint/full unit/browser/runtime evidence.

## Open findings and limits

Scoped new backend findings: **[]**. Continuation-identity and required-dataset held defects are repaired at this exact head. Existing broader feature/backend release caveats remain unchanged.

NOT_RUN by this reviewer: physical iPhone, real export/provider latency/quota, privateHA/MA, populated production restore, authenticated runtime/binding/secret/version/traffic readback and deployment. Browser rendering/runtime and authenticated HTTP end-to-end routes are not asserted here; existing middleware was inspected directly. No external comments, commits, merges, deployments or root application edits performed.
