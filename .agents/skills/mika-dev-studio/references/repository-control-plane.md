# Repository Control Plane

Use existing conventions when they already expose equivalent truth.

## Short agent map

Use the repository's canonical agent entrypoint. When root `AGENTS.md` is canonical or no governed alternative exists, keep it concise: objective/mode, authoritative documents, exact setup/run/verify commands, boundaries/ownership, high-risk areas, active plan location, and required completion evidence. Otherwise preserve the canonical structure and link or amend it according to project policy. An agent map is a router, not project history.

## Durable truth

Material projects should expose equivalents of:

- product objective, non-negotiables, current scope and success criteria;
- architecture, data ownership, external systems and ADRs;
- active/completed execution plans and integration state;
- a revision-bound execution checkpoint for multi-session work;
- project-specific quality budgets, test strategy and Evidence Ledger;
- a current-facts register when material decisions depend on time-sensitive external claims;
- deployment, migration, recovery and result records.

Update these in the same change when implementation changes their truth. Remove stale active instructions, dead flags, obsolete compatibility paths and abandoned plans after material transitions.

For a forensic existing-repository engagement, a Handoff Map may bind these roles to existing canonical files. The ordinary default is `docs/ai-dev/HANDOFF_MAP.json`, but governed placement wins. Generated views declare their lower authority, evidence IDs, packet hash, baseline commit, and freshness trigger; they never silently replace canonical truth.

## Agent-operability

A fresh agent should be able to determine without chat history: what the product is, how to run/test it, what is active, which constraints matter, what evidence supports readiness, and how consequential changes recover. Encode critical invariants in tests/lints/scripts where practical; documentation points to executable truth rather than replacing it.
