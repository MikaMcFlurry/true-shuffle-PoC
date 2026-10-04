# Repository Intelligence — synchronized V2 view

Status **ALIGNED / handoff READY**, generated 2026-09-30T03:54:02.239928+00:00. This means preparation can proceed; it does not mean the requested product passes acceptance. Machine packet: repository-intelligence.json.

Primary R-1: `MikaMcFlurry/true-shuffle-PoC`, `codex/cloudflare-restart-plan`, `59174f6fc3d9da38dcc3a944c3524f8a6bc428f9`. Application/production-source candidate R-2: `claude/true-shuffle-spotify-95zw0m`, `c9bd08246487df1edcb5d19d39ec96c93f04fb9d`. Live frontend matches R-2 assets; exact deployed Worker version unverified. Default main is the unrelated legacy baseline. Authority is current source/runtime for reality and latest owner requests for target; no formal governance regime was activated.

Product: live private Spotify station app, owner satisfaction MIXED. Keep valuable discovery/history/rules; improve continuation and device reliability; add exact unfinished occurrence/native adapter; redesign rejected radio UI. Architecture, operations and the live boundary are in PROJECT_CONTEXT.md. NN-01–11 and D-01–05 are in MISSION.md. No material owner decision is outstanding; Studio has delegated design/implementation detail authority.

## Feature inventory

| ID | Feature | Evidence state | Disposition |
|---|---|---|---|
| F-01 | Cloudflare station playback | IMPLEMENTED_TESTED | KEEP |
| F-02 | Discovery, resurfacing and advanced mix | IMPLEMENTED_TESTED | KEEP |
| F-03 | Listening history/import/memory | IMPLEMENTED_TESTED | KEEP |
| F-04 | Pause and external playback reconciliation | PARTIAL | IMPROVE |
| F-05 | Persistent exact unfinished queue resume | PLANNED_ONLY | ADD |
| F-06 | Quota handling | PARTIAL | IMPROVE |
| F-07 | Cross-device/browser controls | PARTIAL | IMPROVE |
| F-08 | Native HA/MA controller | PLANNED_ONLY | ADD |
| F-09 | Current radio UI | IMPLEMENTED_UNVERIFIED | REDESIGN |

## Gaps and release boundaries

- G-01 (P1, FEATURE_PRESENT_BUT_OWNER_REJECTED): Legacy resume/rebuild contract conflicts with same unfinished queue.
- G-02 (P1, UNVERIFIED_CLAIM): Live quota reason and request pressure not captured.
- G-03 (P1, PLANNED_NOT_IMPLEMENTED): Native HA/MA route and integration acceptance absent.
- G-04 (P2, FEATURE_PRESENT_BUT_OWNER_REJECTED): Current visual design rejected; independent replacement not built.
- G-05 (P2, DEPLOYED_BUT_NOT_REPRODUCIBLE): Exact Worker deployment version/build configuration not verified.
- G-06 (P2, UNVERIFIED_CLAIM): Local browser acceptance blocked before application execution.

These gaps are non-blocking for preparing the aligned handoff, but must not be interpreted as waived product acceptance. No new functional/UI changes, schema migration, live Spotify or HA/MA verification are delivered here. Baseline unit/build results are limited to current behavior, including behavior the owner now rejects.

## Evidence index

- EV-01: CODE_CONFIRMED — Actual app architecture and restart/quota contract findings. Source: src/worker/hub/hub.ts.
- EV-02: DOC_CORROBORATED — Owner requests same durable queue/unfinished song, redesign, integrations and fresh Codex handoff. Source: owner conversation normalized in MISSION.
- EV-03: OBSERVED_RUNTIME — Signed-out domain frontend assets match local build; no deployed Worker SHA proof. Source: https://true-shuffle.mikahertler-72c.workers.dev/.
- EV-04: TEST_CONFIRMED — Cloudflare baseline build/static checks and 280 Vitest tests pass; application source unchanged by packet. Source: docs/ai-dev/EVIDENCE.json.
- EV-05: PROVIDER_CONFIRMED — All branch heads compared; default main is legacy; newest pre-existing app branch is c9bd082. Source: https://api.github.com/repos/MikaMcFlurry/true-shuffle-PoC/branches.
- EV-06: TEST_CONFIRMED — E2E browser launch blocked: executable absent; installation returns invalid ZIP. Source: e2e/app.spec.ts.
- EV-07: PROVIDER_CONFIRMED — Official Spotify quota/rate guidance inspected September 30; per-developer development quota and reason handling. Source: https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates.
- EV-08: PROVIDER_CONFIRMED — MA documents a Spotify Connect plugin; route/device/network capabilities must be checked live. Source: https://www.music-assistant.io/plugins/spotify-connect/.
- EV-09: DOC_CORROBORATED — Screenshot/log show root / and failure before build; empty-root correction not yet verified. Source: docs/LIVE_BASELINE_REVIEW.md.
- EV-10: TEST_CONFIRMED — Impeccable online check failed DNS; existing 4.1.2 retained; seed retry degraded. Source: .agents/skills/impeccable/SKILL.md.

No standalone issues or releases were found in the fresh GitHub inspection. Historic PRs and ADR narratives are supporting context, not proof of present runtime. Related HA/MA instances are external integration targets, not inspected source repositories. Read-first and implementation path: CODEX_START.md → mapped mission/context/plan → canonical incumbent functional documents as relevant. Revalidate source, deployment, tests, external guidance and owner decisions whenever those materially change.
