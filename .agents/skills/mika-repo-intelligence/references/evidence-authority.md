# Evidence and Authority Model

Use two separate authority axes. Never merge them into one generic source-of-truth ranking.

## Current reality authority

Use project-specific rules first. Otherwise prefer, in order:

1. Direct observation of the relevant live or preview environment.
2. Deployment/provider configuration that identifies the deployed artifact and ref.
3. Code and configuration at the pinned deployed or analyzed commit.
4. Executed tests, CI results, migrations, logs, metrics, and reproducible commands for that commit.
5. Current-state documents whose scope, ref, and freshness are explicit and corroborated.
6. Recent commit/PR/issue history.
7. README, handover, status, final-report, or generated summaries that are not independently corroborated.
8. Historical plans, prompts, archived reports, and chat memory.

A higher-ranked source can still be incomplete. Record gaps instead of assuming completeness.

## Target intent authority

Use project-specific governance first. Otherwise prefer, in order:

1. The owner's explicit current decision.
2. Accepted/approved decision records or governance artifacts.
3. A current product/specification document explicitly designated as authoritative.
4. Current owner feedback and acceptance criteria.
5. Supporting design briefs and roadmaps.
6. Historical plans, prompts, generated ideas, and current implementation.

Current code does not automatically define the desired product. Existing features may be accidental, rejected, or disposable.

## Source statuses

Assign one status to every material source:

- `AUTHORITATIVE` - governing for its stated scope.
- `CURRENT_SUPPORTING` - recent and corroborated, but not governing.
- `STALE` - once useful but older than material implementation/decision changes.
- `CONTRADICTED` - a later or stronger source disproves a material claim.
- `HISTORICAL` - intentionally retained context, not current truth.
- `UNRESOLVED` - authority cannot yet be determined.

## Freshness rules

A document is not current merely because its filename says STATUS, FINAL, CURRENT, or HANDOVER.

Check:

- commit containing the file;
- later commits touching the described components;
- branch scope;
- whether referenced test counts, feature counts, architecture, or deployment state still match;
- whether the file explicitly states its authority and date;
- whether a newer approved record supersedes it.

## Claim evidence levels

Use these labels when writing conclusions:

- `OBSERVED_RUNTIME`
- `PROVIDER_CONFIRMED`
- `CODE_CONFIRMED`
- `TEST_CONFIRMED`
- `CI_CONFIRMED`
- `DOC_CORROBORATED`
- `CLAIM_ONLY`
- `INFERRED`
- `UNKNOWN`

Every high-impact statement should carry at least one evidence reference and one evidence level.

## Conflict handling

For each conflict:

1. Quote or paraphrase both claims precisely.
2. Pin each claim to repository/ref/commit/path or external system.
3. Explain which authority axis applies.
4. State the likely resolution only if evidence supports it.
5. Preserve unresolved variants.
6. Ask the owner only when the conflict concerns target intent or governance and cannot be resolved from accepted records.
