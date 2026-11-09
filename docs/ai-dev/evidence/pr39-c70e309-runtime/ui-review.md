# Fresh independent UI re-review: integrated 1.3.2 / PR39

- SUBJECT: exact integrated/deployed source `c70e309a2893891d918bd061e3165a4d19071d90`, PR39 head `a4a06d4fb5cc3b88692e45e3b95ff88df9f48f85`. Scoped UI diff from previously reviewed `39edfed`: `src/client/components/continue-after.tsx` and `src/shared/release.ts`, alongside separately reviewed functional Hub changes. PR40 contains deployment documentation only.
- INDEPENDENCE = **FRESH**. Separate reviewer context with no implementation role, isolated clone `/workspace/true-shuffle-ui-review-132b`, detached exact subject, locally copied dependencies (actual fonts served). Read AGENTS/MISSION, actual source/diff, Mika Red Team and independent contract, Impeccable context/audit/operate guidance. Builder assertions were test leads, not acceptance.
- Scoped VERDICT = **READY** for the changed continue-after presentation and observed client integration. No new material UI finding established. This is not an overall backend/release verdict and does not override the root/backend reviewer’s findings. No application fixes, GitHub mutations or live provider writes by reviewer.

## Actual runtime evidence

`npx playwright test -c e2e/review/continue132b.config.ts`: **5/5 PASS**,9.6s (`ui/browser-accepted.log`). Additional degraded request probe with `--grep 'failed arm'`: **1/1 PASS**,3.4s (`ui/browser-error-offline.log`). Six unique browser cases total, no retries.

The page is actual Preact/Vite/Chromium, private port8853, local fonts; its ordinary API paths are answered by actual HubCore + SQLite + SpotifyClient + FakeSpotify in the test process. No root8787/8788 server was touched. Browser’s clock is fixed to the synthetic Hub clock; Spotify observations happen explicitly in the fixture and real Hub scheduling/settlement is exercised. This establishes the simulated client/provider boundary, not real Spotify end behavior or latency.

Four matrix cases cover **390×844 /1440×1000, day/night**, reduced motion, a very long unbroken outside-song title, actual fonts, no horizontal overflow, no page errors or failed font responses. Keyboard Tab→`Zum Inhalt`, Enter, then usable task controls/navigation.

Each matrix case verifies the complete changed flow:

1. Outside Spotify song shown separately from the saved stable session. Hold the arm API response: the arm button disables, one POST only, no provider playback call and no fabricated acceptance.
2. Accepted arm renders `role=status`, conditional wording “soll … weitergehen” and “nur, wenn Spotify ihn angehalten an seinem Ende zeigt”. Saved session/checkpoint remain byte-for-byte unchanged. Kassetten→Jetzt preserves the armed state.
3. Abbrechen cancels the intent, sends no Spotify play, and does not alter the outside song or saved occurrence.
4. Arm again, then actually observe another outside song in FakeSpotify. The real Hub cancels; UI removes the armed banner, says nothing starts by itself, and points to explicit `TrueShuffle fortsetzen`. No extra play and no saved-session mutation.
5. Arm that new outside song; provider explicitly shows the same song paused at its duration; force an actual observation, settle the scheduled action, observe again. Exactly one provider play, saved session ID/ordered entries/current index retained; client reconciles to observed station playback, removes the outside checkpoint. A provider acceptance alone was not treated as observed playback.

Fifth case uses a real synthetic private Spotify device observation: outside-song/saved-session separation stays available and saved state unchanged. Its second half supplies an explicitly synthetic native-controller snapshot through `/api/state*` and proves the existing native presentation route has no Spotify continue-after control/checkpoint. This is a client routing check, **not** actual private HA/MA playback or a native hardware journey.

Sixth case rejects an arm request503 after a held response. UI shows the actual error, never an accepted banner; intent remains absent, stable saved session unchanged, zero provider play calls. The real browser offline event disables a fresh request. No app change was used to pass.

Existing client/record tests: `vitest run test/client/observed-playback.test.ts test/shared/release.test.ts` → **23/23 PASS**,2files (`ui/client-release.log`). No functional assertions or known-failure allowlist changed by reviewer.

## Source/copy/visual inspection

`ContinueAfter` only changes text: accepted wish now says “soll” and describes the specific paused-at-end requirement. Existing busy/error/refresh/cancel behavior is preserved; no client state-machine implementation change. `release.ts` describes the same conservative path and explicitly says Spotify might not expose this end state; autoplay/crossfade result in an explicit resume choice. The remaining categorical pause/Likes claims must still be assessed against backend edge evidence; this scoped UI pass does not prove provider correctness or waive any backend finding.

Personally inspected current captures `continue-armed-390-day.png`, `continue-aborted-390-night.png`, `continue-armed-1440-night.png`, `continue-aborted-1440-day.png` (all eight matrix captures archived). Long title and new notice wrap; task copy and controls remain readable. Fixed navigation and transient toast can appear over a full-page capture at its current viewport position; that is not proof of persistent layout overlap. Browser clock control keeps transient toast text present during these captures. No CSS/token changes or cosmetic preferences were promoted to findings.

Impeccable detector ran once on the two changed presentation files: `ui/impeccable-detector.json` = `[]`. Context records the existing stale sidecar as historical navigation; no regeneration or application styling repair.

## Preserved fixture attempts / limitations

- Initial exploratory run used the previous abort wording “nichts fortgesetzt” in a test expectation; actual changed message correctly says “startet nichts von selbst”. Interrupted after two assertion failures; preserved in `browser-initial.log`. Fixed only the fixture expectation.
- Next run failed the positive-end client assertion because the fixture advanced time/read state without forcing a provider observation/accepted→observed readback. State-only reads do not prove observed playback. Corrected fixture explicitly observes the paused endpoint state, settles, then observes the played station. `browser-observation-fixture.log` and `fixture-before-observation.ts.txt` preserve this attempt.
- The native synthetic override initially matched `/api/state` without its query string, so the general real-Hub route answered instead. Fixed the review route to `/api/state*`; no native app defect inferred. The run with4positive-flow PASS/1fixture failure is retained in `browser-native-fixture.log`; accepted final5/5 log is separate.

Physical iPhone/Safari/PWA, real Spotify end-state/crossfade/latency/quota behavior, private HA/MA hardware and populated production restore/rollback-forward are **NOT_RUN**. Root owns comprehensive integrated gates and actual Cloudflare deployment/asset/resource/public-browser verification. No claim of ongoing monitoring or full production acceptance.
