# Evidence Ledger 1.2

Use one JSON object per integrated delivery subject. Project-specific commands and evidence remain in the project. The canonical schema is [evidence-ledger.schema.json](evidence-ledger.schema.json).

## Subject and claim

Record:

- `schema_version = "1.2"`, timezone-aware `generated_at`, project, and exact `subject.revision`, `artifact_ref`, `environment`, and `environment_class`;
- mode, delivery target, claim, and whether the claim is a material release;
- applicable `change_profiles`;
- independent review level/verdict;
- required categories and structured external blockers;
- requirements snapshot, protected requirement mappings, open findings, and gates.

Use `AUTONOMOUS_BUILD`, `GOVERNED_EXECUTION`, or `EXPERIMENT`. Claims are `PRODUCTION_LIVE`, `RELEASE_CANDIDATE`, `VERIFIED_PROTOTYPE`, `PARTIAL`, or `BLOCKED`.

## Change profiles

Select every applicable profile:

- `USER_FACING`
- `PERSISTENT_STATE_CHANGE`
- `AUTHORIZATION_OR_SENSITIVE_DATA`
- `PAYMENTS_OR_FINANCIAL_STATE`
- `AI_TOOL_SIDE_EFFECTS`
- `REALTIME_OR_MULTIPLAYER_AUTHORITY`
- `PERFORMANCE_CRITICAL`
- `NONE` only when no listed profile applies

Profiles mechanically add required categories. A reviewer still checks that profile selection is honest.

## Gate and evidence records

Each gate has unique `id`, category, `required`, status, evidence, and rationale. Each evidence record has a unique `id`, `kind`, `ref`, `result`, exact `subject_revision`, and timezone-aware `observed_at` no later than ledger generation.

`PASS` requires evidence. A required gate cannot be `NOT_APPLICABLE`. `required_categories` must exactly equal the category set of required gates. Every protected requirement ID must exactly match the requirements snapshot and resolve to one or more required gate IDs.

## Derived minimums

Every positive claim requires `build` and `critical_journey`.

- A material positive claim requires `independent_review`, `FRESH`, and a ready verdict.
- `PRODUCTION_LIVE` additionally requires `subject.environment_class = PRODUCTION`, `deployment`, `post_deploy`, and `operations`, and permits no external blocker.
- `RELEASE_CANDIDATE` requires at least one structured external authority/provider blocker; engineering incompleteness is not an external blocker.
- `VERIFIED_PROTOTYPE` requires `EXPERIMENT` mode.
- `USER_FACING` requires `ui_runtime` and `accessibility`.
- `PERSISTENT_STATE_CHANGE` requires `migration`, `data_invariants`, and `recovery`.
- Sensitive/auth/payment/AI-side-effect/multiplayer profiles require `security_privacy`.
- Performance-critical/realtime/multiplayer profiles require `performance_reliability`.

No positive claim may retain P0/P1 or another blocking finding. `READY` permits no open finding; `READY_WITH_NON_BLOCKING_FINDINGS` requires at least one non-blocking P2/P3.

Run:

```bash
python3 scripts/validate_evidence.py path/to/EVIDENCE.json
```

The validator cannot prove that external references, selected profiles, or copied requirements are truthful. Reproduce important evidence and compare inputs with authoritative sources.
