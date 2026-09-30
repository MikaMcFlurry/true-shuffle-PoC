---
name: mika-red-team
description: Independently falsify a software product's claim of correctness, quality, migration or deployment safety, and release readiness. Use for a fresh material-release review after integration or repair, or an explicitly independent audit of an app, service, AI system, game, data change, infrastructure release, repository intelligence packet, or handoff claim. Treat packets, handoffs, builder summaries, and ledgers as untrusted indexes to reproduce. Do not use for routine builder self-review, comprehensive gate maintenance owned by mika-verification, repository handoff creation, first-pass implementation, or silent repair during the initial review.
---

# Mika Red Team

Try to prove the claim false. Effort, test count, generated packets, and builder confidence are not evidence.

Read [references/independent-review-contract.md](references/independent-review-contract.md). Load [references/attack-catalog.md](references/attack-catalog.md) selectively for changed risk.

## Preserve independence

- Prefer a fresh agent/context and isolated read/test environment.
- Reconstruct intent from authoritative project truth and observable behavior.
- Treat a Repository Intelligence Packet, Handoff Map, builder summary, and Evidence Ledger as navigation aids. Verify their baseline, authority mapping, and important evidence directly.
- Report `INDEPENDENCE = FRESH`, `PARTIALLY_INDEPENDENT`, or `COMPROMISED`. Only `FRESH` can satisfy material acceptance.
- Never let an implementer or handoff author self-accept where separation is required.

## Review

1. Validate the minimal packet, objective, target, exact subject revision/artifact/environment, authority model, and claimed state. Missing critical input is a finding or blocker.
2. For an existing repository, compare current head/deployment with the intelligence and handoff baselines. Treat material drift, duplicate canonical truth, or untraceable generated claims as review findings.
3. Select distinct risk lenses from changed surfaces, trust boundaries, continuity risk, and evidence gaps; avoid duplicate generic reviews.
4. Run the integrated product and selectively reproduce critical claimed evidence. Verification owns the comprehensive matrix; independently attack the highest-risk claims.
5. Attack happy paths, boundaries, degraded states, misuse, recovery, migrations/deploy order, integration seams, stale facts, and claim/evidence mismatches.
6. Compare protected requirement IDs with the authoritative normalized source. Missing or softened non-negotiables prevent a positive verdict.
7. Record reproducible findings with direct evidence, impact, repair direction, and required regression evidence.
8. Return exactly one verdict: `BLOCKED`, `NOT_READY`, `READY_WITH_NON_BLOCKING_FINDINGS`, or `READY`, plus independence, reviewed subject, structured open findings, and untested critical surfaces.

Any P0/P1 blocks. A P2 blocks when it violates a core journey or stated trust, safety, accessibility, security, correctness, data-integrity, reliability, performance, continuity, or operational bar. Critical `NOT_RUN` surfaces reduce readiness.

Use `BLOCKED` for P0/P1 or unavailable authoritative subject, required authority, or runnable critical evidence. Use `NOT_READY` for a completed review with other fixable blocking quality/gate failures. Without an exact identifiable subject, no positive verdict is allowed.

Do not repair during the initial review. After material repairs, reproduce the issue and inspect affected/regression evidence in a fresh re-review. A patch description or updated handoff does not close a finding.
