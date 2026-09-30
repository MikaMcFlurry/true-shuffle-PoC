---
name: mika-engineering
description: Design and implement production-grade software architecture, agent harnesses, integrations, migrations, and delivery mechanics across web, mobile, backend, desktop, AI, data, infrastructure, and games. Use for a bounded engineering task or as mika-dev-studio's implementation phase, especially when a repository must become reproducible, observable, safely parallelizable, migratable, and recoverable. Consume mapped repository-intelligence and canonical handoff constraints when present. Do not use for repository forensics, product-direction-only work, evidence-only QA, or independent release acceptance.
---

# Mika Engineering

Build the strongest credible implementation for the chosen product direction and delivery target.

Read [references/harness-and-agent-legibility.md](references/harness-and-agent-legibility.md) when operability is not proven. Read [references/platform-routing.md](references/platform-routing.md) only for a material stack decision. Read [references/delivery-and-recovery.md](references/delivery-and-recovery.md) for parallel work, persistent-state change, or release.

## Engineer from a truthful baseline

1. Ground architecture, runtime, data ownership, trust boundaries, dependencies, tests, environments, deployment, and observability. Run the current system where possible.
2. If a fresh Repository Intelligence Packet or Handoff Map exists, follow its evidence and canonical links while independently verifying material claims. Generated views do not override canonical governance or current runtime evidence.
3. Separate real constraints from accidental legacy. Choose the simplest architecture that satisfies journeys, quality properties, continuity, and operations.
4. Assess the harness before scaling work. If agents cannot deterministically set up, run, observe, reset, test, and reproduce the product, repair that loop first.
5. Define contracts, ownership, failure behavior, invariants, and migration/recovery semantics before concurrent writers depend on them.
6. Build vertical slices early; add meaningful tests and diagnostics alongside behavior.
7. Parallelize by dependency and ownership; isolate writers/environments when practical; assign shared-contract evolution and integration. Fall back to dependency-ordered sequential work when isolation is unavailable and record the limitation.
8. Integrate deliberately and rerun combined build, static, integration, runtime, and contract checks. Branch-local success is not system evidence.
9. Treat accessibility, security/privacy, performance, reliability, recovery, and operations as design inputs.
10. Update the mapped canonical repository truth in the same change when implementation changes it. Mark stale intelligence/evidence and require refresh rather than silently carrying old claims forward.
11. Return the engineering handoff to Verification or Studio.

For a bounded engineering request, keep harness repair, documentation, and cleanup proportional to the affected surface. Do not turn a patch into repository-wide takeover. Return a narrow blocker or follow-up when broader work was not delegated.

## Invariants

- Make data ownership and trust boundaries explicit; separate authentication from authorization.
- Validate untrusted boundaries and minimize privileged paths and data exposure.
- Model retries, idempotency, concurrency, partial failure, and durable background work when relevant.
- Keep secrets out of source, logs, fixtures, screenshots, and artifacts.
- Prefer deterministic fixtures/checks over timing sleeps and manual folklore.
- Encode critical architecture constraints in tests, lints, schemas, or scripts where practical.
- Verify current official guidance for important platform, dependency, provider, licensing, or security decisions.

## Handoff

Return: exact baseline; product criteria and stable requirement IDs; architecture/contracts; changed surfaces; setup/run/verify commands; requirement-to-surface/test mapping; integration state; migrations and recovery status; observability; evidence already run; invalidated packets/evidence; known risks, failed assumptions, and remaining work. Do not claim release readiness; `mika-verification` and fresh `mika-red-team` own those judgments.
