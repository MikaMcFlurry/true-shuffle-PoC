# Lifecycle and Handoffs

## Phase exits

| Phase | Required durable or returned output |
|---|---|
| Ground/Intake | Triage, baseline, normalized intent, capability ledger, narrow blockers; validated intelligence packet only when forensic grounding triggered |
| Product | Direction verdict, element decisions, critical journeys, measurable criteria |
| Harness | Reproducible commands/fixtures/runtime access or explicit repair work |
| Plan | Dependency graph, owners, shared contracts, integration, evidence and recovery |
| Engineering | Integrated working state, changed surfaces, commands, migrations, remaining risks |
| Verification | Evidence Ledger with `PASS/FAIL/NOT_RUN/NOT_APPLICABLE` and coherent claim |
| Red Team | Findings, reproduction, independence level, verdict, regression evidence required |
| Delivery | Actual release/deploy identifiers or named external blocker; post-deploy evidence |
| Close | Final result plus updated repository truth |

Repository Intelligence is a conditional read-only phase, not a universal prelude. Repository Handoff is a separate conditional close/transition phase: invoke it only for an `ALIGNED` packet when the owner requests a durable handoff or the existing control plane is missing/stale. Governed repositories may map roles to canonical files with `LINK`/`AMEND`; creation of a parallel truth tree is not a phase exit.

## State derivation

- `PRODUCTION_LIVE`: production actually changed, applicable gates and independent material-release review pass, and immediate production journeys/operations pass.
- `RELEASE_CANDIDATE`: applicable product/release gates pass, but a named external authority/provider prerequisite blocks production.
- `VERIFIED_PROTOTYPE`: the explicit experiment criteria pass; never use it to disguise unfinished production intent.
- `PARTIAL`: useful work exists but target gates do not all pass.
- `BLOCKED`: a blocking finding, authority/capability gap, unrecoverable risk or fixed-constraint impossibility prevents progress.

`READY_WITH_NON_BLOCKING_FINDINGS` qualifies a positive state only when every remaining finding is documented and no critical journey, trust, safety, accessibility, security, correctness, data integrity, reliability or stated quality bar is invalidated.

## Repair loop

For each blocking finding: assign owner, reproduce, repair, re-run affected evidence and regressions, and re-review material risk. Continue while evidence improves. If progress stalls, change strategy rather than replaying the same attempt. Never close a P0/P1 by elapsed rounds.

## Final result

Return: mode; intended and achieved delivery state; product/architecture decisions; changed systems/files and exact external identifiers; Evidence Ledger and independent verdict; migration/deployment/rollback state; meaningful costs/provider dependencies; remaining findings; narrow blockers; durable project records updated; intelligence/handoff packet baselines when used; next action if incomplete.
