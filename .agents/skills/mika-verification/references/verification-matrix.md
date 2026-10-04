# Verification Matrix

Select by product risk and target. Record omitted relevant categories as `NOT_RUN`, not silence.

## Harness and build

- deterministic setup, canonical commands, fixtures/reset and environment isolation;
- build/package, type/static analysis, lint/format/config, generated schema consistency;
- CI/evaluation harness and authoritative repo-routing freshness.
- when repository packets/maps are used: packet schema, commit/timestamp/hash binding, evidence-ID resolution, canonical-source preservation and declared write-scope consistency.

## Behavior and runtime

- unit, representative integration and critical E2E/runtime journeys;
- empty/loading/error/permission/degraded/offline behavior;
- retries, idempotency, concurrency, races, restart/reconnect, cache/state, time/locale boundaries.

## Trust and experience

- actual visual hierarchy, responsive/device/input behavior and runtime errors;
- accessibility semantics, focus, keyboard/controller/touch, contrast, text scaling and reduced motion as applicable;
- authentication, authorization/object access, validation, secret/token handling, data exposure/logging, untrusted files/content/prompts/tools.

## Performance and reliability

- startup/load/interaction/API latency, throughput/concurrency, resource use and dependency degradation;
- games/animation: frame time/pacing, input latency, physics stability, assets/streaming;
- AI: representative evals, malformed/hallucinated output, injection/tool safety, timeout/rate limit/fallback, privacy and cost/latency.

## Data and operations

- representative migration, mixed-version compatibility, invariants/counts, destructive-loss checks;
- backup/snapshot/export and tested/validated recovery;
- environment/secret references, deploy health, post-deploy journeys, diagnostics/alerts and rollback.

## Game-specific additions

- boot-to-play, input/remapping, save/load/corruption recovery, physics exploits, multiplayer authority/desync/reconnect, progression/economy integrity and network degradation.
