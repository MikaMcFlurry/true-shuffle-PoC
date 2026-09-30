---
name: mika-repo-handoff
description: Convert a fresh aligned Repository Intelligence Packet and owner decisions into a concise, evidence-linked, agent-ready control plane for an existing repository. Use when a takeover, rescue, modernization, feature program, release, or governed execution needs durable repository guidance; when canonical agent/current-state/product/architecture/operations/quality pointers are missing or stale; or when the user explicitly wants a repository prepared for Mika AI Dev. Preserve existing canonical structures, write only on an isolated reviewable path allowed by project governance, validate provenance and drift, and avoid duplicate truth systems. Do not use for greenfield work, repository analysis, or a bounded change in an already well-mapped repository.
---

# Mika Repo Handoff

Turn reconstructed truth into a durable navigation and execution control plane. Do not re-analyze a project from scratch when a current validated packet exists.

Read [references/profiles.md](references/profiles.md), [references/write-and-preservation.md](references/write-and-preservation.md), and [references/handoff-topology.md](references/handoff-topology.md). Read [references/agents-md-contract.md](references/agents-md-contract.md) before creating or amending an agent entrypoint.

## Require trustworthy input

Use both synchronized packet artifacts and require:

- `schema_version = mika.repository-intelligence.v2`;
- `packet_status = ALIGNED`;
- `handoff_readiness.status = READY` with no blocker IDs;
- exact repository/ref/full commit baseline;
- current owner decisions and non-negotiables;
- live project governance and canonical-source rules.

Run the packet validator against the current primary commit immediately before writes. If code, decisions, deployment, or authority changed materially, refresh through `mika-repo-intelligence`; never patch an old conclusion into seeming current.

## Select the smallest profile

- `LEAN`: compact single-runtime product; consolidate roles into a few files.
- `STANDARD`: normal app, site, PWA, game, backend, or service.
- `LIVE_SYSTEM`: active users/data/integrations require continuity, recovery, and operations.
- `GOVERNED`: project-specific authority and acceptance control placement and mutation.
- `MULTI_REPO`: several repositories/components require coordinated boundaries.

Combine profiles only when evidence requires it. Profiles define roles, not mandatory filenames.

## Plan preservation before writing

1. Verify repository, target ref, current head, and packet baseline.
2. Inventory existing agent instructions, current-state/product/architecture/operations/quality documents, and governance artifacts.
3. For every logical role choose `CREATE`, `UPDATE`, `LINK`, `AMEND`, `SKIP`, or `BLOCKED`.
4. Prefer `LINK` to a suitable canonical file. Use `AMEND` for a scoped companion. Never silently replace authoritative history or create a competing Current State, Decision Log, Source Register, or acceptance system.
5. Choose a project-allowed Handoff Map path. Default ordinary repositories to `docs/ai-dev/HANDOFF_MAP.json`; governed repositories may require another path. Do not force root `AGENTS.md` or `docs/ai-dev` when canonical rules designate another entrypoint.
6. Define an exact write allowlist before mutation. It must contain only the map and files treated as `CREATE`, `UPDATE`, or `AMEND`.
7. Use an isolated branch/worktree and reviewable commit/PR unless live governance specifies another mechanism.

## Build a compact control plane

Use [references/handoff-map.schema.json](references/handoff-map.schema.json). Multiple logical roles may map to one concise file when that improves context efficiency.

Required roles:

- `agent_entry`, `start_here`, `mission`;
- `current_state`, `product_truth`, `feature_inventory`;
- `architecture_runtime`, `run_deploy_operations`, `quality_risks`, `owner_decisions`;
- `intelligence_markdown`, `intelligence_json`, `evidence_manifest`.

Add `production_baseline` for `LIVE_SYSTEM`, `related_repositories` for `MULTI_REPO`, and `governance` for `GOVERNED`.

Use the scaffold only when equivalent artifacts do not exist. The compact `PROJECT_CONTEXT` template can satisfy several roles; split it only when project size or ownership warrants separate sources.

## Preserve traceability

Record in the map:

- exact intelligence baseline and SHA-256 of the packet JSON;
- actual map path and profiles;
- treatment, authority, evidence/decision source IDs, and freshness trigger for each role;
- branch/base commit and exact write allowlist.

Create `EVIDENCE_MANIFEST.json` mapping every active role/path to packet evidence and owner-decision IDs. Do not include secrets or raw sensitive data.

## Validate and hand back

Materialize the handoff and run:

```bash
python3 scripts/validate_handoff.py /path/to/repository --map path/to/HANDOFF_MAP.json
python3 scripts/validate_handoff.py /path/to/repository --map path/to/HANDOFF_MAP.json --git-check
```

The Git check requires the analysis baseline to be an ancestor and rejects changed/untracked paths outside the map's exact write allowlist. It lets handoff-only documentation commits exist without falsely declaring the intelligence baseline stale.

Then verify paths/links, packet hash, role coverage, placeholders, sensitive values, and read order. Commit only the handoff scope, open a PR when appropriate, and follow governance for merge/acceptance.

Return exact status, source baseline, branch/commit/PR, placement map, created/updated/linked files, validation evidence, unresolved blockers, and a one-line AI Dev start command following [references/output-contract.md](references/output-contract.md).

## Living-system rule

The handoff is current only while its baseline and freshness conditions remain valid. After material development, update canonical project truth and refresh/revalidate the intelligence/handoff when code, deployment, authority, target intent, or mapped roles drift. Never preserve stale generated prose merely to avoid documentation work.
