---
name: mika-verification
description: Verify software behavior, migrations, deployments, and delivery claims with direct auditable evidence. Use during or after implementation to select and run project-relevant gates, exercise real runtimes and critical journeys, maintain a subject-bound machine-checkable Evidence Ledger, or decide whether a production, release-candidate, or experiment claim is supported. Use repository-intelligence risks as test leads but reproduce important evidence. Do not use as the fresh independent adversarial acceptance reviewer; that boundary belongs to mika-red-team.
---

# Mika Verification

Prove what the product does in the environments users and operators actually experience.

Read [references/verification-matrix.md](references/verification-matrix.md) and [references/evidence-ledger.md](references/evidence-ledger.md). Read [references/ui-runtime.md](references/ui-runtime.md) for a user-facing surface. Read [references/release-state-contract.md](references/release-state-contract.md) before a delivery verdict.

## Verify

1. Reconstruct the delivery target, exact subject, critical journeys, changed surfaces, trust boundaries, failure modes, target environments, and measurable budgets.
2. Treat Repository Intelligence and Handoff artifacts as test indexes. Verify their current baseline and reproduce material claims; stale or claim-only items become explicit gaps.
3. Establish a baseline and inventory existing checks. State what each proves and does not prove.
4. Choose applicable `change_profiles`, then required gates from the matrix. Never omit a relevant category silently.
5. Run fast deterministic checks first, then representative integration, real runtime/E2E, visual/accessibility, security/privacy, performance/reliability, migration/recovery, and operations checks as applicable.
6. Bind every observation to the exact reviewed revision, artifact, environment, and timezone-aware time. Material code, configuration, data, or deployment changes invalidate affected gates.
7. Snapshot the authoritative normalized requirements source/revision and map every non-negotiable ID to required gates.
8. Record the independent review level, verdict, and structured open findings against the same subject.
9. Maintain Evidence Ledger `1.2` and run `python3 scripts/validate_evidence.py <ledger.json>`.
10. Rerun affected gates plus regressions after repair. Return failed/not-run gates and the strongest claim the evidence supports.

## Evidence discipline

- Use only `PASS`, `FAIL`, `NOT_RUN`, or `NOT_APPLICABLE`.
- Require direct evidence for `PASS`; source appearance, a screenshot, or provider success response alone proves only its observed layer.
- Require real runtime/visual evidence for user-facing claims and actual production checks for production claims.
- Increase depth for auth/authorization, sensitive data, payments, destructive migrations, public APIs, autonomous tool actions, realtime/multiplayer authority, safety-critical behavior, and large cutovers.
- Keep secrets and live sensitive data out of evidence artifacts.

## Post-deploy

After a production change, run critical journeys, data/migration invariants, and operational checks against the actual target. Inspect available diagnostics. Repair or roll back on failure. Claim ongoing monitoring only when a real alerting or automation mechanism exists.

The validator proves structural and claim coherence, not truth. Fresh `mika-red-team` review remains required for material positive release claims.
