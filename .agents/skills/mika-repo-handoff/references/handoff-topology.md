# Handoff Topology

`HANDOFF_MAP.json` is the machine-readable routing contract. It may live at the ordinary default `docs/ai-dev/HANDOFF_MAP.json` or any project-authorized repository-relative path.

## Core roles

- `agent_entry`: first agent-facing map or approved addendum.
- `start_here`: concise human/agent read order and current baseline.
- `mission`: next outcome, freedom, constraints, success gates, and blockers.
- `current_state`: delivery reality, environments, active work, blockers, and freshness.
- `product_truth`: owner outcome, users, non-negotiables, preferences, and delegated choices.
- `feature_inventory`: evidence state and `KEEP/IMPROVE/REDESIGN/REMOVE/ADD/PIVOT/DEFER/STUDIO_DECIDES` dispositions.
- `architecture_runtime`: components, interfaces, data, integrations, deployment, invariants, and traps.
- `run_deploy_operations`: verified setup/run/test/deploy/migration/recovery/diagnostic paths.
- `quality_risks`: executed/not-run evidence, open risks, release constraints, and next verification.
- `owner_decisions`: current owner choices and delegation; link historical records.
- `intelligence_markdown`, `intelligence_json`, `evidence_manifest`: packet and traceability.

Multiple roles may map to one compact `PROJECT_CONTEXT.md` when treatment matches and section boundaries are explicit. Authority remains role-scoped in the Handoff Map; a generated section cannot elevate a supporting or canonical section, or vice versa. Use separate documents when mixed authority would be ambiguous or when size, ownership, governance, or update cadence justifies them.

## Conditional roles

- `production_baseline` for `LIVE_SYSTEM`.
- `related_repositories` for `MULTI_REPO`.
- `governance` for `GOVERNED`.

## Authority

Use `CANONICAL`, `SUPPORTING`, `GENERATED_VIEW`, `HISTORICAL`, or `NONE`. A generated view never outranks the canonical source it summarizes. Record evidence and owner-decision source IDs plus a freshness trigger for every active role.
