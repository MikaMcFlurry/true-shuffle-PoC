# ERR-01…08 / MAN-01…05 — Abdeckung und Befunde (Phase 4 §B1/B2)

Stand: 2026-08-01 · Quelle: unabhängige Opus-Testrunde (`tests/test_error_matrix.py`,
`tests/test_manual_matrix.py`, 36 Tests) + Lead-Fix-Pass `67e4009`.
Live-Spalten bleiben BLOCKED (siehe LIVE_TEST_GUIDE.md).

## Zuordnung (Zeile → Tests → Status → Live-Restlücke)

| Zeile | Tests | Status | Live-Restlücke |
|---|---|---|---|
| ERR-01 kein aktives Gerät | `test_err01_no_active_device_refuses_and_moves_nothing`, `…_names_a_device_action_in_german` (ex-xfail, seit `67e4009` grün: `ProviderNoActiveDevice`, 409 + deutsche Geräteaktion), `…_watcher_backs_off_instead_of_hammering` | PASS(automated) | AN-7: ob Spotify real 404 `NO_ACTIVE_DEVICE` liefert (LT-12) |
| ERR-02 Premium fehlt | `test_err02_missing_premium_is_an_understandable_block`, `…_keeps_the_deck_untouched` (402, deutscher Satz, Lauf erhalten) | PASS(automated) | ob ein Free-Konto real 403 `PREMIUM_REQUIRED` liefert |
| ERR-03 401/Refresh | `test_err03_an_expired_token_is_refreshed_once_on_session_open`, `…_a_401_during_a_command_is_not_silently_retried` | PASS(automated) mit dokumentierter Design-Grenze | **Bewusste Bauweise:** Refresh nur proaktiv beim Sitzungsöffnen; ein 401 MITTEN im Kommando wird nicht reaktiv geheilt (formal matrixkonform: „höchstens ein kontrollierter Retry" = null). Echte Token-Rotation nur live |
| ERR-04 429 | `test_err04_quota_answers_429_and_sends_no_second_command`, `…_backoff_respects_retry_after`, `…_watcher_does_not_repeat_the_command_under_quota` | PASS(automated) | reale Retry-After-Werte/Quotenfenster |
| ERR-05 5xx/Timeout | `test_err05_one_retry_after_a_transient_error_advances_exactly_once`, `…_the_failed_attempt_leaves_no_ledger_trace` | PASS(automated) | ob ein Timeout live das Kommando trotzdem ausführt (halbe Zustellung). **Dokumentierte Asymmetrie:** gescheiterte Advance-Kommandos stehen nicht im Ereignis-Ledger (nur Logs); `window_reassert_failed` dagegen schon. Bewusst so belassen (Event-Spam-Risiko im Watcher-Retry) |
| ERR-06 Track unverfügbar | `test_err06_a_permanent_failure_consumes_one_failure_hop_per_call`, `…_over_http_the_run_survives_an_unplayable_title`, `…_caught_reactively_as_promised` (ex-xfail, seit `67e4009` grün: reaktiver `PLAYBACK_FAILED`-Zweig, 1 Hop/Aufruf) | PASS(automated) | wie Spotify einen unspielbaren Titel im `PUT /play` konkret ablehnt. Start-Zeitpunkt bleibt harter Fehler (bewusst: kein stiller Konsum beim Start) |
| ERR-07 Disconnect | `tests/test_retention.py` (6 Tests, F10 dreistufig) | PASS(automated) | — |
| ERR-08 DB-/Prozessrestart | `test_err08_a_crash_between_command_and_booking_leaves_no_half_move`, `…_after_the_booking_keeps_the_transition_whole` (+ `tests/test_restart_e2e.py`) | PASS(automated) | **Dokumentierter Preis der ADR-002-Reihenfolge:** Crash zwischen Kommando und Verbuchung ⇒ nach Neustart geht dasselbe `play` ein zweites Mal raus (verbucht genau einmal). Live-Frage: ist das identische `PUT /play` folgenlos? |
| MAN-01…04 × 3 Policies | `test_manual_use_matrix[…]` (12), `test_a_long_manual_queue_suspends_under_every_policy[3×]` | PASS(automated) | „nach der manuellen Queue" ist über die API nicht beobachtbar (AN-1/AN-5, LT-7/LT-10); Suspend-Obergrenze ist der ehrliche Ersatz |
| MAN-05 Gerätewechsel | `test_man05_a_device_change_is_no_drift_and_the_run_just_continues[3×]`, `…_with_another_title_is_ordinary_drift`, **neu:** `test_watcher.py::test_the_watcher_follows_playback_to_a_new_device` | PASS(automated) mit dokumentierter Produktentscheidung | **Lead-Entscheidung (2026-08-01):** Gerätewechsel bei WEITERLAUFENDEM Plan-Titel ist bewusste Nutzung, keine Übernahme — unter ALLEN drei Policies keine F8-Episode; der Watcher folgt dem Gerät (`device_changed`-Event), damit Kommandos das gehörte Gerät erreichen. Die Matrix-Spalten „pausiert/Entscheidung erscheint" greifen bei MAN-05 also bewusst NICHT, solange unser Titel weiterläuft; erst ein fremder Titel macht den Wechsel zur normalen Drift. Live: ob das gesetzte uris-Fenster den Gerätewechsel übersteht (LT-9 Gerätewechsel) |

## Auto-Resume-Positionstreue (Nebenbefund 8, gefixt)

`manual_tick(auto_resume)` re-asserted das Fenster jetzt positions-erhaltend,
wenn der erwartete Titel nachweislich läuft (Watcher reicht seinen
Playback-Snapshot durch) — Parität zu ADR-004. Test:
`test_window_reassert.py::test_auto_resume_preserves_the_position_when_the_plan_title_plays`.
Der ältere Pin `play_positions[-1] == 0` in `test_manual_matrix.py` bleibt
korrekt: ohne Snapshot (direkter Service-Aufruf) startet auto_resume
weiterhin bei 0 — dokumentiertes Verhalten beider Pfade.
