# Independent explicit availability-trial review

Verdict: **READY**, bounded local correction only. Independence: **FRESH**. Open findings: **none**.

Subject: frozen working source against parent commit `431352e13a1b6d9a8f293ffd8cd33717caf951ff`, identified by the SHA-256 manifest below. Reviewer did not implement application changes. Eleven independent adversarial tests run the actual HubCore/SQLite, Spotify client and Gate with a fake provider; no real Spotify/playback requests were made. The earlier artist-albums review does not itself accept this new explicit quarantine mechanism.

## Contract and verified boundaries

The owner explicitly authorized a test reset. The authenticated POST `/api/spotify/availability-test` is an intentional new action, protected by the existing custom-header CSRF check and session generation enforcement. It does not run automatically on status refresh. Only an identical, ambiguous unscoped `QUOTA_EXCEEDED` record with no identified endpoint can move from global state to catalog quarantine. Revision and active-probe checks fence this move. Registry performs the move and its single-row original-hold backup in one synchronous storage transaction. Local original-hold backup is likewise bounded to one key.

The original deadline is preserved for catalog requests and all playback/control writes; a stronger or unknown preexisting catalog hold wins. The final post-CAS shared catalog snapshot is copied with its actual revision. Success of devices/player/history reads does not authorize playback or prove independent Spotify quota buckets. All newly identified general failures and ordinary rate/unknown-reason failures retain global precedence. New exact GET quota on devices/player/history has its own family gate.

The trial sends at most one request for each exact devices/player/recently-played GET, and at most one token refresh, with a four-request budget and no automatic same-endpoint retry. Known family deadlines are skipped. General/auth/network/server failure stops remaining trial requests. Twelve simultaneous calls were independently coalesced to exactly three GETs; a restart inside 60 seconds reused the saved result without HTTP. DeviceViews are returned for the immediate authorized response but excluded from the persisted diagnostic trial summary.

Independent lost-response attack: quarantine commits, RPC reply is lost, then Hub restarts. The next explicit trial observes the newer shared clear, does not republish old global metadata, and still enforces catalog/write quarantine. Independent race attack: an identified general hold is added immediately after CAS; the trial makes zero GETs, reports stopped, and cached results never clear the newer global cause. Active-probe/stale-revision CAS attempts leave both gates intact.

Independent method/path attacks verify PUT/POST/DELETE at the essential player path and non-exempt catalog GET paths cannot use the read exemption. Player-held history fallback coverage ingests actual fake-provider recent history without changing the durable session or saved player snapshot.

Five executions of the actual transpiled SpotifyFunctionStatus component cover global unknown/future and family future/expired/unknown waits. Current gates override old successful result labels. Rechecks respect known deadlines/global precedence. The copy explicitly leaves controls untested, retains catalog wait, separates token refresh/local blocks, and describes a partial observation period rather than a completed 24-hour measurement.

## Evidence and finding closure

Independent final run: **62 tests PASS, six files, 1.19 seconds**, including **11 reviewer-authored adversarial cases**. [Focused test log](AVAILABILITY_TRIAL_TESTS.log), [five actual component renders](AVAILABILITY_TRIAL_RENDER.log), [portable attack source](AVAILABILITY_TRIAL_ATTACKS.test.ts.txt), [render harness](AVAILABILITY_TRIAL_RENDER.mjs.txt). To reproduce the attacks, copy the test text into `test/spotify/availability-independent.test.ts` in an isolated checkout and run Vitest. Adjust the render harness's absolute source path when moving workspaces.

The proposed local diagnostic deadline mismatch is **closed**: final code fetches the post-CAS catalog snapshot, stores its actual cooldown/revision, and existing focused regressions cover both a longer known deadline and an unknown deadline through expiration of the shorter original global hold.

Parent separately reports 354 integrated unit/Worker and 20 browser cases plus static/build checks PASS before the final catalog-snapshot refinement; quota implementer reports 53 focused tests and worker/test typechecks PASS after that refinement. Those are builder validations, distinct from this independently reproduced run. Require the final integrated/CI results to bind the same application hashes before deployment.

## Unverified acceptance

Full mission acceptance remains **BLOCKED**. The owner's actual trial, later owner provider recovery, real playback writes, HA/MA recovery, developer-account bucket attribution/limits/reset time, sustained multi-user capacity, and actual populated-storage restore are **NOT_RUN** by this reviewer. This local verdict does not claim Spotify quota resolved or the owner will receive any successful endpoint response. The explicit trial is a deliberately authorized partial-function experiment, not a provider recovery guarantee or automatic legacy migration.

## Exact source binding

| Path | SHA-256 |
|---|---|
| `src/worker/spotify/client.ts` | `c27117e1264164c0e961822b629fa505f89075b459ffff5b1e597824b5f02175` |
| `src/worker/spotify/gate.ts` | `343a95e99b22ab7f89b4d27e4f22d147b72da3b0647cd67b9bc189afae651cac` |
| `src/worker/registry.ts` | `a80c49252e48d386ed823ee030c1e5d9f3d46f6636d62358153e8c8d17f879b7` |
| `src/worker/hub/hub.ts` | `1c4563507ce839fceca78da24ccd69009b497d578606fa9e72972b2b3d53b13a` |
| `src/worker/userhub.ts` | `679e15aeae6f6407b878faaa4776d3465bc2b3c2fe4af8c363ddd563febbd29b` |
| `src/worker/index.ts` | `ba84206af54ef450fc2d5b5c98413fbd90e908af2b4e074d9220ca51330e4662` |
| `src/client/api.ts` | `53fc433d58d17ce41b8f0d9379d0240db3ae5181db874e2e3fcfe8958414e957` |
| `src/client/screens/menu.tsx` | `24e231f6995caf8c6741965267e2b327cb93fd289fb4091b1bb71d113b57857b` |
| `src/client/components/spotify-availability.tsx` | `9fc73ecde04f21e671a432d67a202f65438b8b1830e1f7b3eecb257e357d1c49` |
| `test/spotify/availability.test.ts` | `cdc590e35d0ddd22766f49c624f49427e2ecefed6e160b8d781434ad17184228` |
| `test/spotify/artist-scope.test.ts` | `17f90eddc2b009d7292c376d110abfda38db177d0ccdd79fe30ef61bae157c77` |
| `e2e/app.spec.ts` | `213cefd17b2be170f7c09f8b9c3bf6614922df91cdee7da24c1643a1f6766873` |
