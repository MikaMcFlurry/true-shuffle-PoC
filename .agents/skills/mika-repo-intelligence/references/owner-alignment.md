# Owner Alignment Interview

The interview follows evidence reconstruction. It is not a substitute for repository analysis.

## Question selection

Ask only questions that change one or more of:

- product purpose or primary user;
- core loop/journey;
- preserve/remove decisions;
- platform/delivery target;
- live-user compatibility or data migration;
- non-negotiable brand/UX behavior;
- scope boundary between related products;
- regulated/sensitive behavior;
- whether an existing rejected experience should be redesigned or replaced.

Do not ask about stack, filenames, commands, current features, or deploy setup when discoverable.

## Format

For each question use:

### Q[number] - [decision]

**What I found:** concise evidence-backed facts.

**Why this matters:** what downstream choice changes.

**Recommended answer:** one clear recommendation.

**Options:** only materially distinct options.

**Owner answer:** pending.

## Number and pacing

- Prefer 3-7 questions for the complete alignment.
- Ask one at a time only when the user wants an interactive interview.
- Otherwise present all questions compactly and allow: `Use all recommended answers`.
- Resolve dependencies in order: purpose -> users -> core experience -> feature dispositions -> delivery constraints.

## Feature disposition board

Group features into:

- `CORE_KEEP`
- `KEEP_BUT_FIX`
- `REDESIGN`
- `REMOVE_CANDIDATE`
- `MISSING_ADD`
- `DEFER`
- `STUDIO_DECIDES`

Avoid asking the owner to decide every feature individually. Focus on clusters and exceptions.

## Alignment result

Record:

- explicit non-negotiables;
- approved recommended answers;
- owner overrides;
- delegated decisions;
- unresolved decisions and why they block or do not block handoff.

Set packet state:

- `ANALYZED` - facts reconstructed, owner intent not reconciled;
- `ALIGNED` - owner decisions or delegated recommendations resolve material direction;
- `BLOCKED` - a mandatory authority decision remains unavailable.
