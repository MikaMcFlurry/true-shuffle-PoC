# Repository Handoff Result Contract 2.0

Return a compact result.

## Status

Use `COMPLETED`, `PARTIALLY_COMPLETED`, `BLOCKED`, or `FAILED`.

## Baselines and provenance

Report repository, source ref/full commit, packet schema/status/SHA-256, profiles, map path, target branch, and resulting head/commit when created.

## Placement and preservation

For each logical role report path, treatment, authority, evidence/decision sources, and freshness trigger. List explicitly preserved canonical files and the exact write allowlist.

## Repository changes

Report branch, commits, PR, files created/updated/amended, links, and any merge status. Do not imply production or feature changes occurred during handoff preparation.

## Validation

Report packet validation, handoff validation, Git-scope/drift result, path/link checks, placeholder/secret scan, and unavailable checks.

## Remaining issues

Report authority conflicts, missing runtime/provider access, stale/moving baseline, blocked placement, and owner/governance decisions still required.

## Start command

Return one line such as:

`Use @mika-dev-studio. Read the mapped agent entrypoint and HANDOFF_MAP first, verify freshness, then execute the mapped mission through applicable release gates.`
