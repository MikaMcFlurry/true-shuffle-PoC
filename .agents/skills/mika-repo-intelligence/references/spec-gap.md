# Specification and Implementation Gap Analysis

## Build the requirement set

Extract requirement candidates from:

- current product/spec/brief documents;
- accepted decisions and explicit owner feedback;
- acceptance criteria and test plans;
- design systems and UX flows;
- security/privacy/operations requirements;
- task/roadmap items;
- rejected alternatives that prevent repeating old debates.

Label each requirement as `GOVERNING`, `CURRENT`, `HISTORICAL`, `PROPOSED`, or `UNRESOLVED` before scoring implementation.

## Requirement states

Assign one:

- `SATISFIED_AND_VERIFIED`
- `SATISFIED_BUT_UNVERIFIED`
- `PARTIALLY_SATISFIED`
- `IMPLEMENTED_DIFFERENTLY_ACCEPTABLE`
- `IMPLEMENTED_DIFFERENTLY_REJECTED`
- `NOT_IMPLEMENTED`
- `NO_LONGER_DESIRED`
- `OVERBUILT`
- `CONFLICTING_REQUIREMENT`
- `UNKNOWN`

## Quality dimensions

Do not reduce quality to feature presence. Assess, where relevant:

- product coherence and value;
- usability and interaction quality;
- visual/design quality;
- correctness and domain invariants;
- performance and responsiveness;
- accessibility;
- security/privacy;
- reliability/recovery;
- maintainability and testability;
- deployment/operations;
- platform fit.

Owner dissatisfaction is evidence about product quality, but not proof of the root cause. Diagnose the root cause separately.

## Rescue decision

Recommend by component:

- `PRESERVE`
- `REFINE`
- `REDESIGN`
- `REIMPLEMENT_BEHIND_INTERFACE`
- `REPLACE`
- `REMOVE`
- `DEFER`

Avoid all-or-nothing rewrite advice unless interface, data, migration, and evidence support it.

## Overbuild detection

Flag features that:

- consume complexity without serving the core outcome;
- were added because they were easy for an agent, not because the product needs them;
- weaken the primary experience;
- create operations/security burden disproportionate to value;
- conflict with the owner's current target.

Present removal candidates to the owner with a recommendation and consequence.
