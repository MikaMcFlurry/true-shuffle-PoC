# Repository Intelligence Output Contract 2.0

Produce two synchronized artifacts bound to the same exact baseline.

## Owner-readable artifact

Write `REPOSITORY_INTELLIGENCE.md` in this order:

1. owner summary and most important conclusion;
2. repositories, refs, full commits, deployments, modes, unavailable systems, and packet status;
3. separate authority maps for current reality, target intent, governance, and history;
4. current product reality, users, journeys, architecture, data, integrations, deployment, and operations;
5. feature inventory with evidence state, owner disposition, evidence IDs, and quality note;
6. plan/document/code/runtime gaps ranked by impact;
7. quality, security, data, and operational posture with executed, blocked, not-run, and claim-only states;
8. related repositories and branch-only work when relevant;
9. owner decisions, delegated choices, and only remaining material questions;
10. handoff readiness, recommended profile, exact read-first artifact, and next action;
11. concise evidence index.

## Machine-readable artifact

Write `repository-intelligence.json` conforming to `repository-intelligence.schema.json` with `schema_version = mika.repository-intelligence.v2`.

Key rules:

- Use full 40- or 64-character commit IDs for every analyzed Git ref.
- Make every referenced evidence, question, decision, conflict, feature, and gap ID unique in its collection and resolvable.
- Bind code/test/CI evidence to a repository ID, ref, full commit, path/reference, and observation time.
- Require runtime/provider observation time plus environment/artifact for `VERIFIED_LIVE`.
- Require executed test/CI evidence for `IMPLEMENTED_TESTED`.
- Require evidence for every quality `PASS`.
- Keep current reality and target intent authority separate.
- Use structured `handoff_readiness`; `ALIGNED` is valid only with `READY`, no blocker IDs, no undecided feature, no blocking unresolved conflict, and no unresolved material owner question.
- Never store credentials, secret values, raw sensitive records, or large source excerpts.

The deterministic validator checks structural and cross-field coherence. It cannot prove evidence authenticity, correct source selection, or runtime truth.
