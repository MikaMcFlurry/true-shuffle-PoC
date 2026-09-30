# Live System Baseline

Use this only when a product is live, actively used, or production-like.

## Non-disruption rule

- Prefer read-only provider and runtime checks.
- Do not run destructive, load-heavy, billing-triggering, or data-mutating tests against production.
- Use synthetic/test accounts only when explicitly available and safe.
- Never copy live personal, financial, health, credential, or customer data into the analysis packet.

## Establish production identity

Record:

- public/internal URLs, app IDs, store listings and environment names;
- provider project/team/account;
- deployed commit/ref/artifact where discoverable;
- domain/DNS/CDN path;
- release channel and rollout state;
- database/storage/project identity;
- scheduled jobs, queues, webhooks and external integrations.

If deployed-ref provenance is unavailable, classify the deployment as `DEPLOYED_BUT_NOT_REPRODUCIBLE`.

## Critical journey verification

Choose a small set of representative journeys:

- authentication/access;
- core value action;
- persistence/readback;
- payment/order or other irreversible action only in sandbox/test mode;
- error/recovery path;
- mobile/responsive/native platform path where relevant.

Record observed result, environment, time, account type, and side effects.

## Operations map

Assess:

- logs, metrics, traces, crash/error reporting;
- alerts and incident ownership;
- backup, restore and rollback;
- migrations and backward compatibility;
- secrets/config management;
- feature flags and staged rollout;
- rate limits, quotas and recurring costs;
- privacy/data lifecycle;
- support and known incidents.

## Continuation risk classes

- `NO_DEPLOY_PROVENANCE`
- `NO_ROLLBACK`
- `NO_BACKUP_RESTORE_EVIDENCE`
- `MIGRATION_RISK`
- `OBSERVABILITY_GAP`
- `UNOWNED_INTEGRATION`
- `SINGLE_PERSON_KNOWLEDGE`
- `UNVERIFIED_PRODUCTION_CONFIG`
- `DATA_CLASSIFICATION_GAP`
- `ACTIVE_USER_COMPATIBILITY_RISK`

Do not recommend a rewrite before understanding migration and continuity constraints.
