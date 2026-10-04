# Handoff Profiles

Choose the smallest profile that preserves truthful continuation. Profiles define logical coverage, not a mandatory directory tree.

## LEAN

Use for a compact site, prototype, single-runtime tool, or small service. Map several roles to one `PROJECT_CONTEXT.md` plus mission, intelligence, evidence, and an agent entrypoint. Do not create ten tiny files.

## STANDARD

Use for a normal application, website, PWA, game, backend, native app, or service. Separate roles only when size, update cadence, or ownership makes separation clearer than a consolidated context file.

## LIVE_SYSTEM

Add a `production_baseline` role covering deployed artifact/ref, critical journeys, data/migrations, integrations, observability, incidents, backup/restore/rollback, staged rollout, and continuity risks. Never equate repository `main` with production without evidence.

## GOVERNED

Preserve the live canonical topology. Link generic roles to canonical records or add a scoped allowed companion. Never create a competing Current State, Decision Log, Source Register, Result/Review Packet, or acceptance mechanism. Use the project-designated entrypoint and map path. Return `BLOCKED` if no safe write location exists.

## MULTI_REPO

Add a `related_repositories` role covering canonical role per repository/ref, cross-repository interfaces, coordinated change/release order, unique artifacts, and read-first order.

Combine profiles only when each adds necessary behavior, for example `STANDARD + LIVE_SYSTEM` or `GOVERNED + MULTI_REPO`.
