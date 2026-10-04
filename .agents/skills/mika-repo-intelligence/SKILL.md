---
name: mika-repo-intelligence
description: Reconstruct the truthful current state, target intent, authority, architecture, features, branches, deployments, quality posture, documentation freshness, and plan-versus-implementation gaps of an existing software repository before development. Use for repository understanding, takeover, rescue, modernization, lost context, live-product baselining, conflicting plans/code, rejected implementation, or multi-repository identity. Default to read-only analysis, ask only high-impact owner questions after evidence review, and produce a validated Repository Intelligence Packet. Do not use for greenfield ideas, a bounded well-grounded code change, repository mutation, or handoff writing.
---

# Mika Repo Intelligence

Reconstruct repository truth before planning or mutation. Treat documentation, code, tests, branches, deployments, and user statements as separate evidence classes that may conflict.

Read [references/evidence-authority.md](references/evidence-authority.md) before resolving conflicts and [references/github-inspection.md](references/github-inspection.md) for GitHub work. Load only the mode-specific references needed.

## Preserve the investigative boundary

- Default to read-only repository and provider inspection.
- Pin every material conclusion to a repository/ref/commit, runtime/provider observation, or explicit owner statement.
- Separate `CURRENT_REALITY`, `TARGET_INTENT`, `GOVERNANCE`, and `HISTORICAL_CONTEXT`.
- Distinguish code presence, tested behavior, deployed behavior, and real-user use.
- Use `UNKNOWN`, `NOT_RUN`, `BLOCKED`, or `CLAIM_ONLY` when evidence is missing.
- Preserve live project governance and data-class rules. The packet maps authority; it cannot create authority.
- Redact secret values and sensitive records; report only location/type when needed.

## Select the smallest sufficient mode

Read [references/modes.md](references/modes.md).

- `LIVE_BASELINE`: live/actively used system; also read [references/live-system.md](references/live-system.md).
- `LOST_CONTEXT`: owner no longer knows the real state; also read [references/owner-alignment.md](references/owner-alignment.md).
- `SPEC_IMPLEMENTATION_GAP`: plans and implementation disagree; also read [references/spec-gap.md](references/spec-gap.md).
- `PORTFOLIO_RESOLUTION`: several repositories, branches, or deployments may represent the product; also read [references/multi-repo.md](references/multi-repo.md).
- `AUTO`: inspect signals and combine only needed modes.

Do not require a full packet for greenfield work or a bounded change in a small, current, well-understood repository unless risk/authority ambiguity makes it necessary.

## Reconstruct truth

1. **Identity:** resolve repository, default and relevant refs, exact commit SHAs, related repositories, and known deployments. Record inaccessible systems.
2. **Inventory:** inspect the tree, manifests, instructions, plans/status/decision artifacts, load-bearing source, schemas/migrations, tests/CI, deployment configuration, history, and provider/runtime state as applicable. Use targeted reads; deep-read every source capable of changing authority, feature state, safety, or handoff conclusions.
3. **Authority and freshness:** classify each material source on the correct authority axis and as `AUTHORITATIVE`, `CURRENT_SUPPORTING`, `STALE`, `CONTRADICTED`, `HISTORICAL`, or `UNRESOLVED`.
4. **Current reality:** reconstruct users, delivery state, journeys, architecture, data, integrations, deployment/operations, active work, branch-only value, strengths, and known failures.
5. **Feature evidence:** assign exactly one state: `VERIFIED_LIVE`, `VERIFIED_RUNTIME_NONPROD`, `IMPLEMENTED_TESTED`, `IMPLEMENTED_UNVERIFIED`, `PARTIAL`, `PLANNED_ONLY`, `DISABLED_OR_HIDDEN`, `DEPRECATED_OR_DEAD`, `CONTRADICTED`, or `UNKNOWN`.
6. **Gaps:** classify plan/code/runtime/documentation mismatches explicitly and record the smallest resolving action.
7. **Proportional verification:** run safe deterministic checks and inspect real runtime/provider evidence when available. Never use destructive, load-heavy, billing-triggering, or sensitive production tests merely to strengthen a packet.
8. **Owner briefing:** explain findings in plain language before asking anything.
9. **Alignment:** only when target intent materially remains open, ask 3–7 evidence-backed questions with recommended answers. Allow one-message approval; never ask discoverable facts.

## Produce and validate the packet

Create synchronized `REPOSITORY_INTELLIGENCE.md` and `repository-intelligence.json` following [references/output-contract.md](references/output-contract.md) and [references/repository-intelligence.schema.json](references/repository-intelligence.schema.json).

Run:

```bash
python3 scripts/validate_packet.py repository-intelligence.json
python3 scripts/validate_packet.py repository-intelligence.json --current-primary-sha <current-sha>
```

Use the second form immediately before downstream mutation. Do not mark a packet `ALIGNED` unless every material target-intent decision is resolved or explicitly delegated, no blocking authority conflict remains, and `handoff_readiness.status` is `READY`.

## Route without duplication

- Stop with the packet when the user wants understanding only.
- Route a fresh aligned packet to `mika-repo-handoff` only when a durable handoff is requested or missing/stale repository guidance would impede continued material work.
- Pass a fresh packet directly to `mika-dev-studio` when the repository already has an adequate canonical control plane.
- Route governed mutation and acceptance through `mika-governance`.

Do not replace uncertainty with a polished narrative or claim access, execution, deployment, or tests without direct evidence.
