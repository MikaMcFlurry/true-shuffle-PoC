# Analysis Modes

## AUTO

Use when the user supplies a repository without knowing which process is needed.

Detect signals:

- live URL, store listing, production config, active users -> `LIVE_BASELINE`;
- many status/handover files, branch sprawl, owner confusion -> `LOST_CONTEXT`;
- detailed plans plus partial/poor implementation -> `SPEC_IMPLEMENTATION_GAP`;
- similarly named repos, rewrites, forks, legacy folders, successor claims -> `PORTFOLIO_RESOLUTION`.

Combine modes when evidence requires it.

## LIVE_BASELINE

Goal: establish a non-disruptive operating baseline for a product that people use.

Required additions:

- identify production/preview environments and deployed ref;
- map data stores, migrations, external integrations, auth, secrets boundaries, observability, backups, rollback, support and incidents;
- verify critical journeys safely;
- distinguish repository state from production state;
- identify changes that require migration, compatibility, staged rollout, or user communication;
- create a continuation baseline, not a redesign yet.

Primary output: production-safe baseline and handoff risks.

## LOST_CONTEXT

Goal: explain the real state to the owner, then reconcile it with desired intent.

Required additions:

- reconstruct an owner-readable product map;
- identify source conflicts and why overview was lost;
- show feature inventory grouped by user value, not file structure;
- ask 3-7 high-impact questions after the briefing;
- record recommended dispositions and owner answers;
- end with an aligned continuation target.

Primary output: shared understanding and owner-aligned feature direction.

## SPEC_IMPLEMENTATION_GAP

Goal: compare intended product against actual implementation and quality.

Required additions:

- parse requirements, acceptance criteria, plans, design, tasks, decisions and rejected alternatives;
- map each requirement to implementation evidence and runtime behavior;
- separate missing work from wrong work and low-quality work;
- detect overbuilt features that do not serve the target;
- identify architecture/spec decisions that should be preserved, reversed, or re-evaluated;
- recommend salvage, redesign, selective rewrite, or full replacement by component.

Primary output: evidence-backed gap matrix and rescue strategy.

## PORTFOLIO_RESOLUTION

Goal: determine which repository/ref/deployment represents each part of a product.

Required additions:

- search the connected account/organization for name variants and related descriptions;
- inspect legacy/archive/import directories and cross-repository links;
- compare activity, deployment config, package identity, domains, content, databases, and migration history;
- classify each repository as `CURRENT_PRIMARY`, `CURRENT_COMPONENT`, `LEGACY`, `SUCCESSOR`, `EXPERIMENT`, `HANDOFF_ONLY`, `ARCHIVE`, `DUPLICATE`, or `UNRESOLVED`;
- do not delete or consolidate anything during analysis.

Primary output: repository portfolio map and recommended canonical boundaries.
