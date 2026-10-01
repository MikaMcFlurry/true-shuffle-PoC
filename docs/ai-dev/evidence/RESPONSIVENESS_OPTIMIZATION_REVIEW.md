# Responsiveness and request-pressure independent review

**Scoped verdict: READY**  
**INDEPENDENCE: FRESH**  
**Reviewed application:** `30ae6a2d5349e3f37bce18ab39b3c920c5543c35` on `codex/implement-cloudflare-restart`.  
**Comparison baseline:** `2d96fb6890e070af7c141e9cb59b80c704709d82`.  
**Review date:** 2026-10-01. **Full mission status: PARTIAL.**

This verdict covers the source change's local, simulated transport correctness, truthful client state, queue/history continuity and measured request pressure. It does not certify the original live iPhone defect as fixed, live provider latency, sustainable Spotify capacity, private HA/MA behavior or a production rollout. Those surfaces remain explicitly untested below.

The reviewer did not implement application changes. Initial adversarial findings were reported to separate implementers without silent repair. After their repairs, the reviewer independently ran the final source in an isolated copy, compared every application source file with the sealed Git commit, and reran the failing journeys. Builder summaries and historical evidence counts were navigation only. This follows [Mika Red Team](../../../.agents/skills/mika-red-team/SKILL.md) and its [independent review contract](../../../.agents/skills/mika-red-team/references/independent-review-contract.md).

## Exact subject and authority

The [source manifest](RESPONSIVENESS_OPTIMIZATION_REVIEW_SOURCE.json) records SHA-256 for all **61 application source files**, committed test sources, package/lock files and runtime/test configuration. Each application file matched both the isolated tested copy and `git show` of the reviewed commit. In particular:

| File | SHA-256 |
| --- | --- |
| `src/worker/hub/hub.ts` | `5af1f54483c0a254f253f4d7fc149fe66bf5079d7b1d03ef40129645efb35489` |
| `src/worker/hub/observation-policy.ts` | `59e43847914884a79aa7a76a343ccd6e89f2fb067eb0e85b0678c017a332f2e4` |

Authority was reconstructed from `AGENTS.md`, `CODEX_START.md`, the mapped `MISSION.md`, execution plan and project context. NN-01 through NN-11 retain their original meanings. The mapped intelligence baseline (`3f4eb83…`) and earlier song-clock evidence predate this change; they are not proof of this application's behavior. The final handoff must refresh their source/state binding separately.

The diff preserves schema, Durable Object class names/identities, bindings, migration tags and runtime configuration. The scheduler adds ordinary persisted key/value markers, not a destructive migration. No reviewer action used real Spotify credentials or wrote production state.

## Independently reproduced evidence

The [evidence JSON](RESPONSIVENESS_OPTIMIZATION_REVIEW_EVIDENCE.json) contains assertion names/results, baseline and final request counts, all four reviewer-only probe files as executable source, their hashes, and the original rendered ambiguity failure excerpt. These probes can be reconstructed in a disposable checkout using the instructions in that file.

| Final-source check | Result | What it establishes |
| --- | --- | --- |
| Transport, session, recovery, quota, skip truth, observation policy/scheduling, provider client/gate, pressure and reviewer probes | **129 passed**, 14 files | Includes five reviewer backend probes; actual provider-call order, delayed/error responses, durable recovery and request counting use real HubCore/SQLite with FakeSpotify. |
| Selected original robustness guard/history cases | **11 passed**; 106 intentionally unselected | Long-held bans, 40-hour/weekend guards, observed listening replaced in Spotify, paused/out-of-sight history, replay counted as a distinct play. |
| Actual Chromium render, client playback suite plus reviewer probes | **25 passed** | Seven reviewer cases attack ambiguous writes, stale observation envelopes, projection age, second-tab pause claims, vanished-device recovery, native pause isolation and route navigation. API responses are controlled local fixtures. |
| Baseline archive, same selected robustness cases | **11 passed** | Establishes that the regressions discovered during integration were introduced, rather than pre-existing failures. |
| Fresh baseline and final full-day request audit | **1 test passed on each source** | Independently reproduces the numerical comparison below. The final audit is already included in the 129 above. |

The 140 backend passes and 25 rendered passes are this reviewer's evidence. Backend tests and pressure were executed on `f5c8e0f36c6cc909e3329eeec77c3a1ef672d10d`; its worker/core/shared source, backend tests and configuration are byte-identical in the replacement commit. Only Home, Store and the client browser tests changed. The independent repaired-client render matched all final application hashes before binding to `30ae6a2d5349e3f37bce18ab39b3c920c5543c35`. Earlier broad provisional runs are not counted as final-source proof. The initial nine guard/history failures were investigated and repaired; selected final regressions preserve their assertions. Fixture changes make actual app-opening intent explicit (`refresh: true`) and permit the accepted pause's one-second durable observation. The original RT24 alarm timing remains intact.

The builder's separate comprehensive replacement-source browser gate finished **39/39 passed**, zero retries (51.8 seconds); the reviewer inspected its local output. Builder static/type/lint/build checks and the full **428-test** backend gate passed; the latter carries forward over the identical backend bytes. These are supporting integration gates, not additions to the reviewer's independent counts.

Reproduction commands, from the isolated final source after restoring the embedded reviewer probes:

```sh
PRESSURE_REPORT=/tmp/responsiveness-redteam-final-pressure.json \
AUDIT_SOURCE_REVISION=30ae6a2d5349e3f37bce18ab39b3c920c5543c35 \
npx vitest run \
  test/hub/transport.test.ts test/hub/session.test.ts \
  test/hub/recovery.test.ts test/hub/quota.test.ts test/hub/skips-truth.test.ts \
  test/hub/observation-policy.test.ts test/hub/observation-scheduling.test.ts \
  test/hub/request-pressure.test.ts test/hub/usage-audit.test.ts \
  test/spotify/client.test.ts test/spotify/gate.test.ts \
  test/hub/redteam-responsiveness.test.ts test/hub/redteam-token-next.test.ts \
  test/hub/redteam-scheduler.test.ts

npx vitest run test/hub/robustness.test.ts \
  -t 'skips a song turned down while the player held|40-h hold|weekend with the phone out|song heard a minute and replaced by a start in Spotify|song seen playing a minute, paused, then out of sight|RT24-02'

npx playwright test e2e/client-playback.spec.ts e2e/redteam-responsiveness.spec.ts
```

## Findings and repair recheck

**Open findings: `[]`.**

Each issue below was material to a protected journey and blocked scoped acceptance until its repair was reproduced. RO-01 through RO-08 concern intermediate integration; sampled initial source hashes are archived in the evidence JSON. RO-09 was independently reproduced on the first sealed candidate. Closure applies to the exact final commit above.

| ID / severity | Reproduction, expected and observed failure | Final repair and regression evidence |
| --- | --- | --- |
| RO-01 / P2 | Render/cache entry 0; provider naturally advances to entry 1 before fenced Next preflight. Expected rejection without POST. Initial implementation adopted entry 1 then skipped to entry 2, violating NN-04/06. | Recheck session and entry IDs after the fresh preflight, and reject missing/ambiguous own observation. Independent original probe and committed natural-advance/session-switch/failed-read regressions pass. |
| RO-02 / P2 | Apply pause at the fake provider, then return HTTP 500; render that response. Expected uncertain/frozen state. Backend returned an ordinary failure and the actual browser claimed “Befehl fehlgeschlagen”, although playback had paused. | Only ambiguous actual player-write errors carry `uncertain`; one-second observation is durable. Backend applied-then-error probe and actual-render uncertain/known-rejection cases pass. Token/preflight errors are distinguished by operation metadata. |
| RO-03 / P2 | Next returns 401, then token refresh loses its network response before any authenticated retry. Expected cleared rejected intent. Initial implementation left `pending: submitted`, preventing another fenced Next indefinitely. | Cleanup uses operation-aware uncertainty. Independent 401/token-failure probe passes; committed resume and Next cases preserve checkpoint and permit the same-occurrence retry after restart. Genuine uncertain writes retain their intent. |
| RO-04 / P2 | Ban a held song, leave playback paused/out of sight for 30 minutes, 8 hours, 40 hours or a weekend, then resume/skip onto it. Expected the existing under-30-second protection. Initial slower scheduling allowed 31 seconds or entire songs. | Known held/front/former banned-song risk retains a 20-second observation bound. All four original guard cases pass on baseline and final source. Ordinary safe pauses can still slow down. |
| RO-05 / P2 | Observe about a minute of a song, replace it from Spotify or pause and leave the app; replay a finished song. Expected observed history retained and replay counted separately. Intermediate scheduling dropped history or counted only one play. | App opening requests a real coalesced read, retained intent survives the five-second freshness window, and active foreground cadence remains 45 seconds. Original selected history/replay assertions pass. Independent maintenance/eviction and failed-read probes confirm deadline anchoring and retry freshness. |
| RO-06 / P2 | Reload another tab with `session.status: paused`, no pending command, but a cached matching Spotify observation still playing. Expected awaiting device confirmation. Browser initially said “Pausiert”. | Spotify status mismatch now awaits confirmation. The independent rendered probe passes; a separate native-controller case remains correctly paused. |
| RO-07 / P2 | Accept pause, then return no visible player/device and an observation older than the ACK; advance 21 seconds. Expected explicit saved-song recovery and device choice. Initial unconfirmed state disabled the selector and offered only another pause, stranding the listener until reload. | Independent Chromium probe now selects an iPhone and resumes with exactly the saved session and `newQueue: false`. Device choice is enabled after uncertainty; no observation or checkpoint is invented. |
| RO-08 / P2 | Explicit Sync merely wakes the alarm while ordinary player/history deadlines remain in the future. Expected new observations. Conditional scheduling initially ignored the request. This integration issue was identified by the builder and independently traced/rechecked. | `requestSync()` persists player/history due markers before scheduling. Final observation-scheduling regressions pass through the actual HubCore path; source inspection verifies UserHub calls it. |
| RO-09 / P2 | Accept resume, immediately navigate to station Mix, make a fresh actual playing observation available and advance 4.5 seconds. Expected bounded confirmation. On the initial sealed `f5c8e0…`, the heading remained paused/missing because Home unmount canceled the 1.5/4-second reads. This reproduced the integrated timing failure; station detail caching was not the cause. | The two cached reads now belong to the running visible app and survive route changes; command clearing and Store stop cancel them. The original reviewer probe passes unchanged on `30ae6a2…`; committed route and hidden-page silence cases pass. No extra provider observation is added. |

The completed attacks below found no additional defect: selected-but-absent device IDs remain explicit actual requests; automatic routing prefers the fresh observed target and permits one new discovery only after an actual no-device rejection; a delayed post-command player GET does not hold the ACK; Next does not fabricate a successor checkpoint; pre-command polls cannot overwrite a newer command; account/session changes discard late client results. Projection expires against original observation time, never advances beyond one successor, disables ambiguous Next/rating actions and cannot persist listening progress. The queue preview comes from the durable queue without provider requests.

Policy checks preserve exact operation cooldowns and stale-success revision fences while avoiding unnecessary ordinary-success clear RPCs. Scheduler tests cover restart-persistent successful-read freshness, blocked/failed attempts, independent history deadlines, private/guest obligations, extension under a confirmed history-only wait, and a slow history read during extension preflight. These checks preserve NN-02–09 rather than treating timer estimates as evidence of completed listening.

## Fresh pressure measurements

These are **simulated** 24-hour profiles with 1,200 tracks, real HubCore and FakeSpotify. Setup imports and the initial Play command are outside the measured window; background discovery and maintenance are included. Baseline was independently rerun from its Git archive. Token refreshes remain included, not hidden.

| Profile | Baseline calls | Final calls | Reduction | Final player GETs | Token refreshes, baseline → final |
| --- | ---: | ---: | ---: | ---: | ---: |
| Paused, app closed for 24 hours | 856 | 269 | 68.6% | 137 | 24 → 23 |
| Four hours visible playback, then 20 hours paused/closed | 2,015 | 810 | 59.8% | 441 | 24 → 24 |
| Four hours closed playback, then 20 hours paused/closed | 1,748 | 487 | 72.1% | 201 | 24 → 24 |

The four-hour **active visible** window increases from **510 to 567** calls; active closed playback changes **243 to 244**. The daily gain comes mainly from paused time. Protected reads and the initial fast paused window remain. This is not evidence that every active workload becomes cheaper. The final 15-minute visible/hidden/paused/device/reload/three-tab fixtures measure **40 / 20 / 15 / 55 / 40 / 40** calls. Ordinary history still populates, and a device-only cooldown allows ten new history records during the separately measured 30-minute fixture.

The per-account results cannot establish Spotify's actual developer-account budget, attribution to other applications, reset timing, or capacity for three/five simultaneous listeners. Multiplying a fixture is arithmetic, not a provider capacity test.

## Untested critical surfaces and acceptance boundary

- **NOT_RUN:** Owner's actual active iPhone, disappearance/reappearance behavior, original automatic-target defect, audible response latency and sustained real playback. Local correctness does not establish that the original provider-specific symptom is fixed.
- **NOT_RUN:** Private live Home Assistant/Music Assistant, MA Spotify Connect and native device capability behavior. Native route isolation is checked locally; NN-10 live acceptance is outstanding.
- **NOT_RUN:** Actual Spotify quota/budget, traffic from other developer applications, multi-listener capacity, real provider recovery and production request-pressure measurements.
- **NOT_RUN by this reviewer:** Production deployment activation/readback and restore of actual populated Durable Object storage. Source identity and unchanged schema/bindings were checked locally; no live migration or restore claim follows.

The scoped source result does not close those gates. The full mission remains **PARTIAL**. Comprehensive builder gate results belong to the main evidence ledger and are distinct from the independently reproduced results above.
