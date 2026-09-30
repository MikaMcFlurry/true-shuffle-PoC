# GitHub Inspection Workflow

## Repository metadata

Read:

- repository full name, visibility, archived state, default branch, size and permissions;
- branches and their heads;
- recent commits sorted by actual commit time;
- open and merged pull requests;
- issues and project-specific tracking artifacts;
- tags/releases;
- workflow definitions and recent workflow results;
- branch protection/rulesets when material.

Do not assume the default branch contains the newest or most valuable work.

## Tree inspection

1. Read the top-level tree.
2. Build a recursive path inventory where available.
3. Identify code, docs, generated output, vendored content, archives, binaries, secrets-risk files and large assets.
4. Read manifests before sampling implementation.
5. Sample each load-bearing component, not merely the most visible directory.

## Documents to prioritize

Search common names and equivalents:

- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`;
- `README*`, `STATUS*`, `CURRENT_STATE*`, `HANDOVER*`, `FINAL*`;
- `PRODUCT*`, `BRIEF*`, `SPEC*`, `PLAN*`, `ROADMAP*`, `DESIGN*`;
- `DECISIONS*`, ADRs, task packets, result packets, review packets;
- architecture, security, privacy, operations, deployment and test documents.

The filename is only a discovery hint. Authority must be proven.

## Implementation evidence

Inspect:

- package manifests and lockfiles;
- framework/native project files;
- routes/screens/components;
- domain/core logic;
- API/server functions;
- database schema/migrations/RLS/storage;
- integrations and environment templates;
- tests and fixtures;
- CI, build, deploy and release configuration;
- telemetry and feature-flag integrations.

## History analysis

Use history to answer:

- what changed after a status/report document;
- whether a planned phase was actually implemented;
- whether owner feedback caused a different direction;
- whether tests cited in prose were later replaced or expanded;
- whether branch-only work contains unique value;
- whether the current default branch is an accidental working branch.

## Evidence recording

For every material source, record:

- repository;
- ref;
- commit SHA;
- path or GitHub object;
- evidence level;
- short supported claim;
- freshness/authority status.

Do not expose private raw source unnecessarily in the final owner summary. Use concise path-level references.
