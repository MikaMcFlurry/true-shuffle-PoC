# Release State Contract

All required gates must pass for a positive claim. `NOT_RUN` is not neutral.

- `PRODUCTION_LIVE`: production actually changed; exact deployment, post-deploy, operations, critical journeys, applicable profile gates, and fresh independent review pass; no external or blocking finding remains.
- `RELEASE_CANDIDATE`: applicable product/release/profile gates and fresh independent review pass, but a named external account, credential, provider review, certificate, contract, third-party approval, or unavailable-tool gate prevents production.
- `VERIFIED_PROTOTYPE`: mode is `EXPERIMENT` and experiment criteria pass.
- `PARTIAL`: useful work exists but target gates do not all pass.
- `BLOCKED`: a blocking finding, authority/capability gap, fixed-constraint impossibility, or unacceptable unrecoverable risk prevents progress.

`PRODUCTION_LIVE` and `RELEASE_CANDIDATE` are always material. Only `FRESH` independence with `READY` or coherent `READY_WITH_NON_BLOCKING_FINDINGS` satisfies them. A P0/P1 or explicitly blocking finding defeats every positive state.

Verification owns the subject-bound ledger and coherence check. Red Team owns the adversarial verdict. Studio owns delivery progression but cannot override either evidence boundary.
