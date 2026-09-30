# Delivery and Recovery Engineering

## Parallel work

- Stabilize shared contracts first or explicitly assign their evolution and integration.
- Give each writer a bounded ownership surface and isolated environment when practical.
- Integrate in dependency order and verify the combined system.
- When isolated parallel execution is unavailable, keep the same ownership/contracts but execute sequentially and report the limitation; never simulate parallel results.

## Persistent state

For consequential changes: verify target, snapshot/export when practical, prefer compatible transitions such as expand-migrate-contract, test representative state, validate counts/domain invariants, and exercise or concretely validate restore/rollback/forward-fix. Record whether recovery is `TESTED`, `VALIDATED`, `PLANNED_ONLY`, or `UNAVAILABLE`.

## Release engineering

Treat preview/staging as evidence surfaces, not automatic end states. When production is the target, establish diagnostics first, use staged/canary/flags when risk warrants, execute through actual authorized tools, and hand post-deploy checks to Verification. Repair or roll back when evidence fails.

## Entropy control

After a material transition, remove dead code/flags and obsolete active instructions where safe, consolidate duplicate utilities, close/archive plans, and update the repository map. Preserve useful decision history without leaving contradictory active truth.
