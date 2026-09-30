# Independent artist-albums scope review

Verdict: **READY** for the bounded source correction. Independence: **FRESH**. Open findings: **none**.

Reviewed source: `eb09bcb5ef5ccedc9be951aa38b7042952f3c246` on `codex/implement-cloudflare-restart`, final application/test hashes below. Reviewer independently inspected the actual files and ran isolated copied-source checks; reviewer did not implement application repairs. The deployed owner session is outside this verdict. Full mission acceptance remains **BLOCKED** by outstanding live owner Spotify/HA and populated-storage restore evidence.

## Verified behavior

Only actual GET `/artists/:id/albums` `QUOTA_EXCEEDED` is scoped. POST to that path, quota on another artist endpoint, and unknown artist-albums 429 remain global. Known and unknown waits retain their semantics. Global gates remain effective for every path; artist gates additionally guard that GET family. Independent negative classification attacks verified zero further device HTTP calls after restart under a global hold.

Separate additive Registry state retains revisions, maximum deadlines, probe leases and stale-success fencing per scope. Scoped manual probes use only a saved exact 22-alphanumeric artist path; invalid/missing paths fail without HTTP. An unrelated player success cannot clear artist quota. Diagnostics expose the endpoint template and strip private probe paths. Existing histories, identities, namespaces and queue/checkpoint state are not replaced by this change.

Automatic legacy splitting/clearing was removed. Old global records remain global even with current-hour artist quota and successful critical endpoint counters. Independent real-Hub/SQLite checks exercised local and shared old metadata, including a preceding-hour global rate failure merged into later artist-looking metadata. Diagnostics, devices and early manual recheck preserve the known deadline and make zero HTTP calls. The owner's old general hold may therefore remain until its saved deadline; the correction prevents new artist-albums responses from creating that overbroad hold. Recovery is not established.

Six executions of the actual transpiled DevicesScreen verify artist future/expired/unknown states and combined global/artist waits. An expired global record plus future artist restriction has no false global-hold message; the selected artist recheck is disabled until its deadline. Active global waits take precedence. Device refresh remains an available action and receives ordinary backend/provider error handling.

## Findings closed by final-source re-review

- **RT-A01, P2, blocking:** current-hour actual non-quota 429 evidence was ignored by the proposed legacy proof. Three independent player/artist/token rate counterexamples initially failed. The entire automatic reclassification mechanism is now absent; the historical proof-importing tests are not claimed as executable final tests.
- **RT-A02, P2, blocking:** preceding-hour still-active general rate metadata could be overwritten by a longer artist quota; current-hour counters then incorrectly justified clearing global state. Exact metadata CAS could not reconstruct lost causality, and revision-one alone would not cover an already-merged local record's first publication. Actual Gate/predicate reproduction failed before repair. Removing automatic clearing closes the bypass; two new real-Hub preservation attacks pass on final source.
- **RT-A03, P2, blocking:** global status copy used the selected artist recheck deadline, falsely describing an expired global hold as active. Final source branches on global activity independently; actual combined-scope rendering passes.

## Evidence and limits

Independent final focused run: **41 tests PASS, 6 files, 970 ms**. This includes three reviewer-authored classification attacks, two reviewer-authored legacy preservation attacks, and existing scope/client/gate/quota coverage. [Focused log](ARTIST_ALBUMS_SCOPE_TESTS.log), [six render cases](ARTIST_ALBUMS_SCOPE_RENDER.log), and [historical RT-A02 failure](ARTIST_ALBUMS_SCOPE_HISTORICAL_RT_A02.log) are portable artifacts. Reviewer attack sources and render harness are saved beside this report as `.txt`; copy the two test sources into `test/spotify/` in an isolated checkout to rerun with Vitest. The render harness reads the source checkout path stated in its first line; adjust that path for another workspace.

Root separately reports 341 integrated unit/Worker tests, 18 browser cases, typecheck, lint, build and Wrangler dry-run PASS, and GitHub CI 36712289545 PASS. Those comprehensive runs are builder evidence, distinct from this independent run.

**NOT_RUN:** real owner's endpoint recovery after the saved deadline; Spotify bucket attribution/limits/reset window; sustainable 3/5-user quota capacity; recovery of other apps sharing the developer account; HA/MA provider recovery; fresh live deployment readback for this source; actual populated SQLite restore. A scoped application gate does not prove Spotify endpoint buckets are independent. This report does not claim quota resolved, saved old global gates lifted, workload reduced, or production-wide viability.

## SHA-256 subject binding

| Path | SHA-256 |
|---|---|
| `src/client/api.ts` | `1e4aa0a7d51892bbf5ff3c7950e07f8f623a4781b6c830f664cc16148a9663d4` |
| `src/client/screens/menu.tsx` | `10975a4ec31411c9a6102d6a5a11330bb98dee6cf680b5fd24368876de29ec89` |
| `src/worker/hub/hub.ts` | `fbd846b653dbaea1f556832d77cca749b7e97fa3f0304bf7beb22101cba54735` |
| `src/worker/registry.ts` | `da6338ca09708242fc0db985c96aba6423ed355a72ed3a2957f660a8f0c23bad` |
| `src/worker/spotify/client.ts` | `00cfa5bb97f175d03c22a7b6a1f8cac6ae304b6a39e47f446b9b1b6e83a46ad3` |
| `src/worker/spotify/gate.ts` | `ea4c44ae1519456d15a49886a5e5926274ce4cd65549ee58a68cbabf666c00b0` |
| `src/worker/userhub.ts` | `e069b87914303d47bf97badf3cc3dceafac967cafad310780219eda92b32e68b` |
| `test/spotify/artist-scope.test.ts` | `a9dbb15b3cf4b0016765110254ead3ff14d3bf59a771757d515c5a2c2299d61f` |
| `e2e/app.spec.ts` | `4cfbbe49a947a3ab34762855fc8093439376ab67ac9f77680dd5374e0f2284f3` |

`src/worker/spotify/legacy-scope.ts` is absent. No automatic legacy split/proof RPC remains in final worker source. Documentation-only commits may carry this report without changing the bound application subject.
