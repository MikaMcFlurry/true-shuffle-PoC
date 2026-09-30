# Independent Review Contract

## Minimal packet

- authoritative objective, non-negotiables and quality/release target;
- repository/location plus exact baseline, review head/artifact and target environment;
- changed-surface and migration/deployment inventory;
- critical journeys and project-required gates;
- Evidence Ledger and evidence locations;
- setup/run/test commands and representative data path;
- known findings/blockers and claimed delivery state;
- intelligence packet baseline/hash and Handoff Map path when those capabilities were used;
- governed scope/acceptance rules when applicable.

Every packet and map is a navigation aid. Verify authoritative sources and important evidence directly; reject stale commit/hash binding, invented evidence, duplicate canonical structures, or writes outside the declared allowlist.

## Finding record

- `ID`, `SEVERITY` (`P0`–`P3`), title and affected surface;
- preconditions and deterministic reproduction steps;
- expected, actual and direct evidence;
- user/business/technical impact;
- likely cause only when supported;
- repair direction and regression evidence required.

The final handoff identifies the reviewed subject, independence level, verdict, open findings (`id`, title, severity, blocking), and evidence references so Verification can reject incoherent delivery claims mechanically.

## Severity and verdict

- `P0`: catastrophic safety/security/data/availability/project-failure condition; blocking.
- `P1`: serious critical-function, trust, security, migration, reliability or delivery defect; blocking.
- `P2`: material defect; blocks when it violates the stated product/release bar.
- `P3`: minor/polish; normally non-blocking unless aggregate impact is material.

Verdict selection:

- `BLOCKED`: any P0/P1, unavailable authoritative subject/required authority/runnable critical evidence, or another condition that prevents a credible readiness decision/progression.
- `NOT_READY`: the review completed against an identifiable subject and found other fixable blocking P2/quality/gate failures.
- `READY_WITH_NON_BLOCKING_FINDINGS`: only explicit non-blocking P2/P3 remain.
- `READY`: no open finding remains.

Report `INDEPENDENCE` as:

- `FRESH`: reviewer/context was not involved in implementation, reconstructs intent from authoritative sources, and independently reproduces the material evidence needed for the verdict;
- `PARTIALLY_INDEPENDENT`: reviewer is distinct but inherited conclusions or could not independently reproduce a critical portion;
- `COMPROMISED`: same builder/context or another conflict undermines separation.

List critical surfaces not reproduced. Only `FRESH` can satisfy a material-release independent-acceptance gate; the other levels remain useful defect-discovery evidence.
