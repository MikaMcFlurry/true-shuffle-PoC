# Harness and Agent Legibility

Before broad parallel implementation, determine whether a fresh agent can:

1. install/setup deterministically;
2. start required services and check health;
3. build, lint/typecheck/static-check and test through canonical commands;
4. run integration/E2E and the real UI/runtime;
5. create/reset representative fixtures/data;
6. reproduce a failure with useful logs/correlation context;
7. capture runtime/visual evidence when relevant;
8. work in an isolated worktree/environment when concurrent writers are planned;
9. find authoritative product/architecture/quality/active-plan truth;
10. verify deployment and recovery when relevant.

Classify each as `PASS`, `GAP`, or `NOT_APPLICABLE` with evidence. Repair blocking gaps before scaling agent count. When blindness recurs, add a reusable command, fixture, diagnostic, test or concise routing document; do not compensate with longer prompts.

A short canonical agent entrypoint routes to executable truth; use root `AGENTS.md` only when project policy permits it. Material work leaves an active plan, decisions, integration state and evidence that a future agent can resume without chat history. When a Handoff Map exists, update its mapped canonical sources and invalidate stale generated views/packets instead of creating duplicate truth.
