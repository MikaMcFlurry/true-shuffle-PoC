# Multi-Repository and Branch Resolution

## Discovery

Search for:

- exact and fuzzy project names;
- domain names and brand names;
- `-final`, `-new`, `-v2`, `-website`, `-app`, `-crm`, `-poc`, `-demo`, `-archive` variants;
- repositories referenced by README, submodules, package metadata, deployment config or documentation;
- branches that are newer than the default branch;
- monorepos containing components previously stored separately.

## Classification

Assign each repo/ref one role:

- `CURRENT_PRIMARY`
- `CURRENT_COMPONENT`
- `PRODUCTION_SOURCE`
- `SUCCESSOR`
- `LEGACY`
- `EXPERIMENT`
- `HANDOFF_ONLY`
- `ARCHIVE`
- `DUPLICATE`
- `UNRESOLVED`

A repository can be current for one component and legacy for another.

## Comparison dimensions

Compare:

- latest meaningful activity;
- package/app identity;
- routes/features/content;
- database/migration lineage;
- deployment/project/domain links;
- docs claiming source-of-truth status;
- accepted decisions;
- test/CI maturity;
- assets and data not present elsewhere;
- branch-only work and unmerged PRs.

## Recommendation

Return:

- canonical boundary recommendation;
- migration/consolidation risks;
- unique artifacts that must not be lost;
- which repo/ref the AI Dev team should read first;
- which repos remain reference-only;
- unresolved identity questions.

Do not merge, archive, rename or delete repositories during analysis.
