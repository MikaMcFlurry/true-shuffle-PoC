# Write and Preservation Contract

## Baseline gate

Before writing:

1. validate the aligned packet;
2. compare the current primary head with the packet baseline;
3. refresh intelligence after material drift;
4. resolve live governance and canonical placement;
5. create an isolated branch/worktree when allowed;
6. declare the exact handoff write allowlist.

## Treatment

- `CREATE`: no suitable role artifact exists.
- `UPDATE`: the existing artifact is authoritative and explicitly safe to edit.
- `LINK`: a current canonical artifact already fulfills the role; do not mutate it.
- `AMEND`: add a scoped companion without rewriting the source.
- `SKIP`: the profile does not require the optional role.
- `BLOCKED`: authority/conflict prevents safe placement.

Every required role must be active (`CREATE`, `UPDATE`, `LINK`, or `AMEND`) for a completed handoff.

## Never silently replace

Preserve accepted decisions, governed current-state/source records, legal/security/privacy records, migrations/schemas, scoped agent instructions, owner-authored product truth, and policy-retained history. Mark stale content or link a superseding source only where authorized.

## Write scope and drift

The map's `write_scope.allowed_paths` must exactly equal the map path plus all distinct `CREATE`, `UPDATE`, and `AMEND` role paths. It must not include broad directories, globs, or unrelated files.

For a Git repository, `--git-check` verifies that the packet baseline is an ancestor of the current head and that committed, staged, unstaged, and untracked handoff changes remain within this set. A later product-code change therefore invalidates the handoff check until intelligence and mapped truth are refreshed.

## Privacy

Never copy credentials, secret values, live personal/financial/health/customer data, or private provider payloads. Use environment-variable names and authorized operational identifiers only when needed.
