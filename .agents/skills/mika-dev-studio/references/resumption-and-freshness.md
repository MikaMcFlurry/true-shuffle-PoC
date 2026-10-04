# Resumption and Current-Fact Freshness

## Execution checkpoint

For multi-session work or a narrow blocker, persist a compact project-local JSON checkpoint containing:

- schema version, project and exact subject revision/artifact;
- current lifecycle phase and execution status;
- active plan reference and workstream owners;
- completed, in-progress and blocked items with evidence references;
- external capability/authority blockers;
- migration/deployment/recovery state;
- next executable actions and dependencies;
- update timestamp.

Before resuming, compare the checkpoint subject with current repository/external state using `scripts/validate_checkpoint.py`. Re-ground and invalidate stale steps/evidence when they differ. A checkpoint is stored state, not a promise that work continues asynchronously.

## Current-facts register

When a material decision relies on a vendor/API behavior, pricing, policy, regulation, dependency state, benchmark attribution or model capability that may change, record:

- stable fact ID and supported claim;
- primary source and retrieval time;
- decision(s) that depend on it;
- evidence scope/limitations;
- revalidation trigger or expiry condition.

Reverify before a dependent consequential action when the trigger fires. If no trigger/expiry was recorded for a mutable fact, treat it as stale before consequential use. Do not preserve stale external facts in global Skills.
