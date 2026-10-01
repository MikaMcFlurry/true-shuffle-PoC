# Independent song-clock and transport-order review

Verdict: **READY** for the bounded display clock and command-order patch. Independence: **FRESH**. No blocking findings in the reviewed changes. This is not full mission acceptance, an automatic-device fix, a live Spotify latency measurement, or a claim that the pause button acknowledges immediately.

Reviewed at: 2026-10-01T08:13:18.514687+00:00. Baseline: `3341bea211dbdf1575b13d5d0003d6e6d4996119`, branch `codex/implement-cloudflare-restart`; published reviewed source `0a05d4fb3aa7f6549ac0ec74c3505ab7f5ea6edd` (same application/test file tree as local `bf46bfc`); exact source/test subject is the SHA-256 manifest below. Material changes to these files invalidate this review. Historical canonical deployment/handoff metadata still describes the earlier release and must be refreshed by the implementer before a new delivery claim.

Authority inspected: AGENTS.md, CODEX_START.md, HANDOFF_MAP.json, MISSION.md (NN-02–09 and NN-11), the Mika Red Team skill and independent-review contract. Owner request: locally advance visible song time between Spotify observations, reconcile subsequent observations including seeks, and remove avoidable reads ahead of explicit transport commands. Broad visual redesign belongs to the owner's separate design agent. No schema, binding, migration, identity, provider cooldown, or durable-queue format changes are in this patch.

## Direct independent evidence

- PASS — `npx vitest run test/core/song-progress.test.ts test/hub/session.test.ts`: **29 tests, 2 files**. Actual initial invocation also named a nonexistent regression path; it did not run or contribute to this count. Log `/tmp/ts-song-clock-independent-tests.log`: 29 passed, duration 6.28s.
- PASS — `npx vitest run test/hub/quota.test.ts test/hub/recovery.test.ts test/hub/robustness.test.ts test/hub/skips-truth.test.ts`: **132 tests, 4 files**, duration 88.72s. Log `/tmp/ts-song-clock-independent-regressions.log`. Protected stable occurrence/checkpoint, no-device/provider-rejection recovery, unknown progress, native/Spotify boundaries, private/guest listening, skip truth, and confirmed-operation cooldown regressions remain passing in this simulation.
- PASS — **2 independent isolated degraded-command tests**, real HubCore/node:sqlite/FakeSpotify: established own-context snapshot followed by successful pause and failed player-observation transport returns success, pauses the provider, marks the known held session paused and preserves its observed checkpoint/ordered entries; actual provider429 on pause returns failure and leaves the checkpoint/session unchanged. Script `/tmp/ts-song-clock-extra.test.ts`, config `/tmp/ts-song-clock-vitest.config.mts`, final log `/tmp/ts-song-clock-independent-extra.log`, duration 550ms.
- PASS — actual **Chromium mounted Preact SongProgress**, esbuild automatic JSX transform with the installed Preact dependency, controlled browser clock. Script `/tmp/ts-song-clock-render.mjs`, log `/tmp/ts-song-clock-independent-render.log`. Independently exercised nine cases in the table below. Component test invokes no application API/Spotify transport.

Total independent automated assertions: **163 Vitest tests across 7 files**, plus one real-browser component sequence covering nine distinct cases. Root's integrated suite, build/static gates and full Worker/browser suite are separate implementer evidence; their counts are not represented as independent reruns here.

| Browser attack | Observed result |
| --- | --- |
| Initial active observation at 2:56, three seconds pass | 2:59; active label omits “gespeichert” |
| New cached snapshot with same provider observation | Time continues at 2:59, then 3:00; no reset or double count |
| Fresh backwards seek to 0:12 | Display resets to 0:12, then counts to 0:13 |
| Paused known position | 0:13 gespeichert remains frozen across three seconds |
| Offline/stale-equivalent `playing=false` | Frozen observed position; no simulated provider confirmation |
| Local extrapolation reaches track duration | Clamps at 5:00 / value300000; never advances queue or writes checkpoint |
| Unknown position | Explicit unknown-position fallback; no invented elapsed value |
| Unknown observation timestamp | Saved0:20 stays fixed; no extrapolation |
| Component unmount | Progress DOM removed; timer cleanup runs without errors |

Source inspection independently confirms Home disables estimation for stale/offline, pending session and unconfirmed playback; the timer is child-local render state. The estimator never feeds API calls, shared Store progress, SQLite checkpoint or listening history. Fresh snapshots anchor to serverTime and observedAt rather than counting from the cached snapshot's receipt alone; the client/server wall-clock offset therefore does not itself add drift. Background browser throttling catches up from elapsed wall time when callbacks resume; a track-duration cap does not authorize a next occurrence.

The pause regression deliberately holds GET/me/player and observes FakeSpotify already paused before releasing the GET. This directly establishes transport ordering. Resume's preflight still observes progress, while `observationOnly:true` suppresses the unrelated automatic guard write before the explicit device-selection/start command. Existing no-device, stale-command, restart and rejected-command regressions pass. These tests do not establish that the owner's active-iPhone symptom is reproduced or fixed.

## Limitations and degraded-case boundary

Open findings: **none blocking within the bounded patch**. Automatic active-device owner defect remains unresolved and outside this verdict. Live owner Spotify round-trip time, delayed provider-consistency behavior, HA/MA transport and post-deployment owner acceptance: **NOT_RUN** by this reviewer.

Pause still awaits post-command reconciliation before returning the response; Home remains busy until that response and refresh. Thus the patch sends the actual pause earlier, but does not guarantee immediate button acknowledgment, remove every preflight request on resume, reduce idle polling, or quantify a production speedup.

An initial isolated assertion expected `status:paused` even when play had never been followed by an own-context provider observation and the first subsequent GET failed. It failed: provider pause succeeded, queue/checkpoint were preserved, but the saved status stayed active because the snapshot did not identify the held context. This is the intentional pre-existing context safeguard, not a repaired defect. The final positive degraded test explicitly establishes own-context observation first. With absent/unrelated context, do not infer that a pause proves this particular held occurrence stopped; no fabricated position is saved. Home also requires own observed playback (or its separate native-controller branch) before treating the saved status as playing.

Public deployment/binding/source readback and actual populated-storage recovery are not reproduced here. No production requests or data writes were performed by this reviewer.

## Exact reviewed subject

```json
{
  "src/client/progress.ts": "bca0e72292a77fc0ce9f4036cb7c44e62375d44f71faf19390c7e43a9fe64d32",
  "src/client/components/song-progress.tsx": "2b87076f9ccfd3f05cb4c51b0a36e095eea86b516147969b5baf7888dd9d38c2",
  "src/client/screens/home.tsx": "0549077bcd8e8c86add4999ff7d5afee0063a8db5dc2c69bb3276b7b851b1b0f",
  "src/worker/hub/hub.ts": "63da6524fc87305a3517614c8a2857fb659579fd750b36c6a6007bda9742f431",
  "test/core/song-progress.test.ts": "f32b0ae06b87f613873c27df4a0dc5e53565a9618e22033f570e5343eab8ac1c",
  "test/hub/session.test.ts": "200eff3fd6fe9ea50dfb15811712cb1f4044ddeb81bbf92a67433008d7126212",
  "e2e/app.spec.ts": "55e99f7ddb597ea6ea8697e875926f257120d0030aa7a19a4a3e7a5a5efcd8f2"
}
```

Archived copies of the final successful independent logs and isolated fixtures are in `docs/ai-dev/evidence/song-clock/`; original temporary run paths above preserve execution provenance.
