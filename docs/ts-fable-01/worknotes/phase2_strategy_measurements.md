# Phase 2 — Strategie-Messung gegen den Spotify-Simulator

Evidenzklasse: **VERIFIED_AUTOMATED** (Simulator mit deklarierten Annahmen AN-1..AN-7, siehe `tests/sim_spotify.py`; Live-Gate BLOCKED).
Harness: `tests/forensics/strategy_bench.py` · deterministisch · Poll 1000 ms (Stille zusätzlich bei 250 ms) · Titellänge 29001 ms (bewusst NICHT poll-aligned) · Prefetch-Fenster 5 · Reads zählen gegen die Quota (`rate_limit_reads=True`).

Jede Strategie läuft unter **beiden** AN-2-Policies (`replay_context` / `stop`) — Pflicht für S2, informativ für alle. `S0-additiv` ist der Status quo als Kontrast, kein Kandidat.

Metriken: *post_end_commands* = Commands, die erst NACH einem Trackende nötig wurden — ein Command-Zähler (Proxy), KEINE Stille-Messung; *true_silence_ms* = ms-genaue hörbare Stille aus dem Event-Log bis zum Strategie-Ende, bei Poll 1000 ms und 250 ms; *uncontrolled_repeats* = derselbe Titel mehrfach GEHÖRT (Audio-Stream-Ebene, bis Strategie-Ende) — die Kerninvariante von True Shuffle; *Kontext-Restarts* = bereits gespieltes Material startete hörbar erneut; *max. Queue-Dup* = höchste gleichzeitige Anzahl desselben Titels in der Queue (0 = Queue nie benutzt, 1 = gesund); *Requests gesamt* = Reads + Writes + 429-Wiederholungen; *404* = Player-Commands ohne aktives Gerät (AN-7), gemeldet statt Crash; *manuell gespielt/verdrängt* bezieht sich auf die 2 Nutzer-Titel in Szenario (c); *Geräteverlust überlebt* nur in Szenario (h).

## Szenario a-natuerlich-20 — 20 Tracks, alle natürlich zu Ende (20 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 1 | 30 | 175 | 0 | 0 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 1 | 30 | 175 | 0 | 0 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 4 | 0 | 584 | 0 | 0 | 0 | 589 | 0 | 0 | 3 | 4 | 4 | 0 / 0 | – | – | 19 | ja |  |
| S1-fenster5 | stop | 4 | 0 | 584 | 0 | 0 | 0 | 588 | 0 | 0 | 3 | 0 | 0 | 3980 / 980 | – | – | 19 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 581 | 0 | 0 | 0 | 583 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 19 | ja |  |
| S1-fenster-all | stop | 1 | 0 | 581 | 0 | 0 | 0 | 582 | 0 | 0 | 0 | 0 | 0 | 980 / 230 | – | – | 19 | ja |  |
| S2-kein-prefetch | replay_context | 20 | 0 | 600 | 0 | 0 | 0 | 621 | 0 | 0 | 19 | 20 | 20 | 0 / 0 | – | – | 19 | ja |  |
| S2-kein-prefetch | stop | 20 | 0 | 600 | 0 | 0 | 0 | 620 | 0 | 0 | 19 | 0 | 0 | 19980 / 4980 | – | – | 19 | ja |  |
| S3-ein-slot | replay_context | 1 | 19 | 600 | 0 | 0 | 0 | 621 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 19 | ja |  |
| S3-ein-slot | stop | 1 | 19 | 600 | 0 | 0 | 0 | 620 | 1 | 0 | 0 | 0 | 0 | 980 / 230 | – | – | 19 | ja |  |
| S4-kontext | replay_context | 1 | 0 | 581 | 2 | 0 | 0 | 585 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 19 | ja |  |
| S4-kontext | stop | 1 | 0 | 581 | 2 | 0 | 0 | 584 | 0 | 0 | 0 | 0 | 0 | 980 / 230 | – | – | 19 | ja |  |

## Szenario b-10-native-skips — 10 native Skips in Folge (12 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 6 | 30 | 13 | 0 | 0 | 0 | 49 | 5 | 24 | 0 | 6 | 6 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 6 | 30 | 13 | 0 | 0 | 0 | 49 | 5 | 24 | 0 | 6 | 6 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 3 | 0 | 80 | 0 | 0 | 0 | 84 | 0 | 0 | 2 | 3 | 3 | 0 / 0 | – | – | 11 | ja |  |
| S1-fenster5 | stop | 3 | 0 | 80 | 0 | 0 | 0 | 83 | 0 | 0 | 2 | 0 | 0 | 2998 / 748 | – | – | 11 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 79 | 0 | 0 | 0 | 81 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S1-fenster-all | stop | 1 | 0 | 79 | 0 | 0 | 0 | 80 | 0 | 0 | 0 | 0 | 0 | 998 / 248 | – | – | 11 | ja |  |
| S2-kein-prefetch | replay_context | 12 | 0 | 81 | 0 | 0 | 0 | 94 | 0 | 0 | 11 | 12 | 12 | 0 / 0 | – | – | 11 | ja |  |
| S2-kein-prefetch | stop | 12 | 0 | 81 | 0 | 0 | 0 | 93 | 0 | 0 | 11 | 0 | 0 | 11998 / 2998 | – | – | 11 | ja |  |
| S3-ein-slot | replay_context | 1 | 11 | 90 | 0 | 0 | 0 | 103 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S3-ein-slot | stop | 1 | 11 | 90 | 0 | 0 | 0 | 102 | 1 | 0 | 0 | 0 | 0 | 998 / 248 | – | – | 11 | ja |  |
| S4-kontext | replay_context | 1 | 0 | 79 | 2 | 0 | 0 | 83 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S4-kontext | stop | 1 | 0 | 79 | 2 | 0 | 0 | 82 | 0 | 0 | 0 | 0 | 0 | 998 / 248 | – | – | 11 | ja |  |

## Szenario c-manuelle-queue — 2 manuelle Queue-Titel (nicht im Deck) bei Titel 3 (UC-17/18) (8 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 1 | 24 | 175 | 0 | 0 | 0 | 200 | 5 | 6 | 0 | 1 | 1 | 0 / 0 | 2/0 | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift); m1 spielte als 17. Titel; m2 spielte als 18. Titel |
| S0-additiv | stop | 1 | 24 | 175 | 0 | 0 | 0 | 200 | 5 | 6 | 0 | 1 | 1 | 0 / 0 | 2/0 | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift); m1 spielte als 17. Titel; m2 spielte als 18. Titel |
| S1-fenster5 | replay_context | 2 | 0 | 292 | 0 | 0 | 0 | 295 | 1 | 0 | 1 | 2 | 2 | 0 / 0 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S1-fenster5 | stop | 2 | 0 | 292 | 0 | 0 | 0 | 294 | 1 | 0 | 1 | 0 | 0 | 1990 / 490 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S1-fenster-all | replay_context | 1 | 0 | 291 | 0 | 0 | 0 | 293 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S1-fenster-all | stop | 1 | 0 | 291 | 0 | 0 | 0 | 292 | 1 | 0 | 0 | 0 | 0 | 990 / 240 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S2-kein-prefetch | replay_context | 8 | 0 | 298 | 0 | 0 | 0 | 307 | 1 | 0 | 7 | 8 | 8 | 0 / 0 | 2/0 | – | 7 | ja | m1 spielte als 6. Titel; m2 spielte als 7. Titel |
| S2-kein-prefetch | stop | 8 | 0 | 298 | 0 | 0 | 0 | 306 | 1 | 0 | 7 | 0 | 0 | 7990 / 1990 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S3-ein-slot | replay_context | 1 | 7 | 298 | 0 | 0 | 0 | 307 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | 2/0 | – | 7 | ja | m1 spielte als 5. Titel; m2 spielte als 6. Titel |
| S3-ein-slot | stop | 1 | 7 | 298 | 0 | 0 | 0 | 306 | 1 | 0 | 0 | 0 | 0 | 990 / 240 | 2/0 | – | 7 | ja | m1 spielte als 5. Titel; m2 spielte als 6. Titel |
| S4-kontext | replay_context | 1 | 0 | 291 | 2 | 0 | 0 | 295 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |
| S4-kontext | stop | 1 | 0 | 291 | 2 | 0 | 0 | 294 | 1 | 0 | 0 | 0 | 0 | 990 / 240 | 2/0 | – | 7 | ja | m1 spielte als 4. Titel; m2 spielte als 5. Titel |

## Szenario d-doppelter-tick — jedes Ereignis 2× beobachtet (6 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 1 | 15 | 349 | 0 | 0 | 0 | 365 | 5 | 9 | 0 | 0 | 1 | 0 / 0 | – | – | 5 | ja |  |
| S0-additiv | stop | 1 | 15 | 349 | 0 | 0 | 0 | 365 | 5 | 9 | 0 | 0 | 1 | 0 / 0 | – | – | 5 | ja |  |
| S1-fenster5 | replay_context | 2 | 0 | 351 | 0 | 0 | 0 | 354 | 0 | 0 | 1 | 2 | 2 | 0 / 0 | – | – | 5 | ja |  |
| S1-fenster5 | stop | 2 | 0 | 351 | 0 | 0 | 0 | 353 | 0 | 0 | 1 | 0 | 0 | 1994 / 494 | – | – | 5 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 349 | 0 | 0 | 0 | 351 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | ja |  |
| S1-fenster-all | stop | 1 | 0 | 349 | 0 | 0 | 0 | 350 | 0 | 0 | 0 | 0 | 0 | 994 / 244 | – | – | 5 | ja |  |
| S2-kein-prefetch | replay_context | 6 | 0 | 359 | 0 | 0 | 0 | 366 | 0 | 0 | 5 | 6 | 6 | 0 / 0 | – | – | 5 | ja |  |
| S2-kein-prefetch | stop | 6 | 0 | 359 | 0 | 0 | 0 | 365 | 0 | 0 | 5 | 0 | 0 | 5994 / 1494 | – | – | 5 | ja |  |
| S3-ein-slot | replay_context | 1 | 5 | 354 | 0 | 0 | 0 | 361 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | ja |  |
| S3-ein-slot | stop | 1 | 5 | 354 | 0 | 0 | 0 | 360 | 1 | 0 | 0 | 0 | 0 | 994 / 244 | – | – | 5 | ja |  |
| S4-kontext | replay_context | 1 | 0 | 349 | 2 | 0 | 0 | 353 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | ja |  |
| S4-kontext | stop | 1 | 0 | 349 | 2 | 0 | 0 | 352 | 0 | 0 | 0 | 0 | 0 | 994 / 244 | – | – | 5 | ja |  |

## Szenario e-prozessneustart — Neustart mitten im Run (8 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 2 | 28 | 176 | 0 | 0 | 0 | 206 | 6 | 22 | 0 | 2 | 2 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 2 | 28 | 176 | 0 | 0 | 0 | 206 | 6 | 22 | 0 | 2 | 2 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 2 | 0 | 233 | 0 | 0 | 0 | 236 | 0 | 0 | 1 | 2 | 2 | 0 / 0 | – | – | 7 | ja |  |
| S1-fenster5 | stop | 2 | 0 | 233 | 0 | 0 | 0 | 235 | 0 | 0 | 1 | 0 | 0 | 1992 / 492 | – | – | 7 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 232 | 0 | 0 | 0 | 234 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 7 | ja |  |
| S1-fenster-all | stop | 1 | 0 | 232 | 0 | 0 | 0 | 233 | 0 | 0 | 0 | 0 | 0 | 992 / 242 | – | – | 7 | ja |  |
| S2-kein-prefetch | replay_context | 8 | 0 | 239 | 0 | 0 | 0 | 248 | 0 | 0 | 7 | 8 | 8 | 0 / 0 | – | – | 7 | ja |  |
| S2-kein-prefetch | stop | 8 | 0 | 239 | 0 | 0 | 0 | 247 | 0 | 0 | 7 | 0 | 0 | 7992 / 1992 | – | – | 7 | ja |  |
| S3-ein-slot | replay_context | 1 | 7 | 240 | 0 | 0 | 0 | 249 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 7 | ja |  |
| S3-ein-slot | stop | 1 | 7 | 240 | 0 | 0 | 0 | 248 | 1 | 0 | 0 | 0 | 0 | 992 / 242 | – | – | 7 | ja |  |
| S4-kontext | replay_context | 1 | 0 | 232 | 2 | 0 | 0 | 236 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 7 | ja |  |
| S4-kontext | stop | 1 | 0 | 232 | 2 | 0 | 0 | 235 | 0 | 0 | 0 | 0 | 0 | 992 / 242 | – | – | 7 | ja |  |

## Szenario f-429-jeder-5te — 429 auf jedem 5. Request (Reads inklusive) (12 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 1 | 30 | 134 | 0 | 41 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 1 | 30 | 134 | 0 | 41 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | – | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 3 | 0 | 282 | 0 | 71 | 0 | 357 | 0 | 0 | 2 | 3 | 3 | 0 / 0 | – | – | 11 | ja |  |
| S1-fenster5 | stop | 3 | 0 | 282 | 0 | 71 | 0 | 356 | 0 | 0 | 2 | 0 | 0 | 4988 / 1988 | – | – | 11 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 280 | 0 | 70 | 0 | 352 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S1-fenster-all | stop | 1 | 0 | 280 | 0 | 70 | 0 | 351 | 0 | 0 | 0 | 0 | 0 | 1988 / 238 | – | – | 11 | ja |  |
| S2-kein-prefetch | replay_context | 12 | 0 | 288 | 0 | 75 | 0 | 376 | 0 | 0 | 11 | 12 | 12 | 0 / 0 | – | – | 11 | ja |  |
| S2-kein-prefetch | stop | 12 | 0 | 288 | 0 | 74 | 0 | 374 | 0 | 0 | 11 | 0 | 0 | 13988 / 9238 | – | – | 11 | ja |  |
| S3-ein-slot | replay_context | 1 | 11 | 286 | 0 | 74 | 0 | 373 | 1 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S3-ein-slot | stop | 1 | 11 | 286 | 0 | 74 | 0 | 372 | 1 | 0 | 0 | 0 | 0 | 988 / 488 | – | – | 11 | ja |  |
| S4-kontext | replay_context | 1 | 0 | 280 | 2 | 70 | 0 | 354 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 11 | ja |  |
| S4-kontext | stop | 1 | 0 | 280 | 2 | 70 | 0 | 353 | 0 | 0 | 0 | 0 | 0 | 1988 / 238 | – | – | 11 | ja |  |

## Szenario g-deck-titel-gequeued — Nutzer queued Deck-Titel t05, während t03 läuft (8 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 2 | 19 | 62 | 0 | 0 | 0 | 83 | 5 | 17 | 0 | 2 | 1 | 0 / 0 | – | – | 3 | NEIN | S0 stalled at cursor 3: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 2 | 19 | 62 | 0 | 0 | 0 | 83 | 5 | 17 | 0 | 2 | 1 | 0 / 0 | – | – | 3 | NEIN | S0 stalled at cursor 3: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 2 | 0 | 176 | 0 | 0 | 0 | 179 | 1 | 0 | 1 | 2 | 1 | 0 / 0 | – | – | 7 | ja |  |
| S1-fenster5 | stop | 2 | 0 | 176 | 0 | 0 | 0 | 178 | 1 | 0 | 1 | 1 | 0 | 998 / 248 | – | – | 7 | ja |  |
| S1-fenster-all | replay_context | 2 | 0 | 176 | 0 | 0 | 0 | 179 | 1 | 0 | 1 | 2 | 1 | 0 / 0 | – | – | 7 | ja |  |
| S1-fenster-all | stop | 2 | 0 | 176 | 0 | 0 | 0 | 178 | 1 | 0 | 1 | 1 | 0 | 998 / 248 | – | – | 7 | ja |  |
| S2-kein-prefetch | replay_context | 5 | 0 | 179 | 0 | 0 | 0 | 185 | 1 | 0 | 4 | 5 | 6 | 0 / 0 | – | – | 7 | ja | nie gehört: t03, t04 |
| S2-kein-prefetch | stop | 6 | 0 | 181 | 0 | 0 | 0 | 187 | 1 | 0 | 5 | 0 | 0 | 6994 / 1744 | – | – | 7 | ja | nie gehört: t04 |
| S3-ein-slot | replay_context | 3 | 6 | 183 | 0 | 0 | 0 | 193 | 1 | 0 | 2 | 3 | 2 | 0 / 0 | – | – | 7 | ja |  |
| S3-ein-slot | stop | 3 | 6 | 183 | 0 | 0 | 0 | 193 | 1 | 0 | 2 | 3 | 2 | 0 / 0 | – | – | 7 | ja |  |
| S4-kontext | replay_context | 2 | 0 | 205 | 2 | 0 | 0 | 210 | 1 | 0 | 1 | 2 | 2 | 0 / 0 | – | – | 7 | ja |  |
| S4-kontext | stop | 2 | 0 | 205 | 2 | 0 | 0 | 209 | 1 | 0 | 1 | 1 | 1 | 997 / 247 | – | – | 7 | ja |  |

## Szenario h-geraeteverlust — kein aktives Gerät ab Titel 5 für 3 Polls (AN-7) (12 Tracks)

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0-additiv | replay_context | 1 | 30 | 175 | 0 | 0 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | NEIN | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S0-additiv | stop | 1 | 30 | 175 | 0 | 0 | 0 | 206 | 5 | 24 | 0 | 1 | 1 | 0 / 0 | – | NEIN | 5 | NEIN | S0 stalled at cursor 5: queue duplicate replayed old material (drift) |
| S1-fenster5 | replay_context | 4 | 0 | 297 | 0 | 0 | 1 | 302 | 0 | 0 | 3 | 3 | 2 | 0 / 0 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren; nie gehört: t05 |
| S1-fenster5 | stop | 4 | 0 | 297 | 0 | 0 | 1 | 301 | 0 | 0 | 3 | 1 | 0 | 1994 / 494 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren; nie gehört: t05 |
| S1-fenster-all | replay_context | 3 | 0 | 296 | 0 | 0 | 1 | 300 | 0 | 0 | 2 | 2 | 1 | 0 / 0 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren; nie gehört: t05 |
| S1-fenster-all | stop | 3 | 0 | 296 | 0 | 0 | 1 | 299 | 0 | 0 | 2 | 1 | 0 | 994 / 244 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren; nie gehört: t05 |
| S2-kein-prefetch | replay_context | 12 | 0 | 304 | 0 | 0 | 1 | 317 | 0 | 0 | 11 | 11 | 10 | 0 / 0 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren; nie gehört: t05 |
| S2-kein-prefetch | stop | 12 | 0 | 360 | 0 | 0 | 0 | 372 | 0 | 0 | 11 | 0 | 0 | 11988 / 2988 | – | ja | 11 | ja |  |
| S3-ein-slot | replay_context | 2 | 12 | 361 | 0 | 0 | 2 | 376 | 1 | 0 | 1 | 1 | 1 | 0 / 0 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren |
| S3-ein-slot | stop | 2 | 12 | 361 | 0 | 0 | 2 | 375 | 1 | 0 | 1 | 0 | 0 | 988 / 238 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren |
| S4-kontext | replay_context | 2 | 0 | 349 | 2 | 0 | 1 | 354 | 0 | 0 | 1 | 1 | 1 | 0 / 0 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren |
| S4-kontext | stop | 2 | 0 | 349 | 2 | 0 | 1 | 353 | 0 | 0 | 1 | 0 | 0 | 988 / 238 | – | ja | 11 | ja | 404 NO_ACTIVE_DEVICE: Command verloren |

## S1-Fenstergrößen-Sensitivität — 200 Tracks, natürlich zu Ende (policy replay_context)

Boundary-Kosten = ceil(N/Fenster) − 1 Fenstergrenzen, jede eine post-end-Command-Stelle. `S1-fenster-all` hat 0 Grenzen NUR, weil Fenster == Playlist-Länge (Sonderfall); das dokumentierte Maximum des `uris`-Arrays ist offen — bei einem Live-Cap unter N fällt S1-all auf das Fensterverhalten zurück.

| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1-fenster5 | replay_context | 40 | 0 | 5840 | 0 | 0 | 0 | 5881 | 0 | 0 | 39 | 40 | 40 | 0 / 0 | – | – | 199 | ja |  |
| S1-fenster50 | replay_context | 4 | 0 | 5804 | 0 | 0 | 0 | 5809 | 0 | 0 | 3 | 4 | 4 | 0 / 0 | – | – | 199 | ja |  |
| S1-fenster-all | replay_context | 1 | 0 | 5801 | 0 | 0 | 0 | 5803 | 0 | 0 | 0 | 1 | 1 | 0 / 0 | – | – | 199 | ja |  |

## Lesehinweise

- **Polling ist der dominante Kostenfaktor**: die Requests-gesamt-Spalte besteht zu >90 % aus 1-Hz-Reads, die bei allen Strategien praktisch identisch sind. Eine Quota-Argumentation über die 429-Spalte allein wäre unehrlich — Reads zählen hier deshalb mit (BASE-05: rollierendes 30-s-Fenster; seit Juli 2026 Quota pro Developer-Account).
- **true_silence_ms hängt primär am Poll-Intervall, nicht an der Strategie**: dieselbe Zelle bei Poll 250 ms zeigt je Übergang ~¼ der Stille. Die Titellänge 29 001 ms ist bewusst nicht poll-aligned; bei 30 000 ms fiel jedes Trackende exakt auf eine Poll-Grenze und die Stille aliaste auf 0.
- **uncontrolled_repeats zählt nur bis zum Strategie-Ende** (bei S0 bis zum Stall) — was das Gerät danach weiterspielt, steht in Rest-Queue/Notizen.
- S1-fenster-all setzt das gesamte Restfenster als `uris`-Array; das dokumentierte Maximum der Body-Größe ist offen (live zu prüfen, 10k-Playlists!) — siehe Fenster-Sensitivitätstabelle.
- S4-`playlist`-Spalte zählt Playlist-Erstellung + Item-Writes; diese laufen außerhalb des Player-Rate-Limit-Pfads des Simulators.
- Szenario (c)/(g): die Semantik »Queue vor Kontext« ist **AN-5** (angenommen, live LT-10 — nicht dokumentiert); ob ein `play`-Override die manuelle Queue erhält, ist AN-1 (live LT-7); dass identische URIs nicht dedupliziert werden, ist AN-6 (LT-11).
- Szenario (g) ist die Kernprüfung der Produktinvariante: `uncontrolled_repeats` zeigt, welche Strategie einen manuell gequeueten Deck-Titel doppelt hörbar macht.
- Szenario (h): 404-Verhalten ohne aktives Gerät ist **AN-7** (LT-12). »überlebt« heißt: kein Crash und Run beendet — übersprungene Deck-Titel stehen in den Notizen (»nie gehört«).
- S2 unter `replay_context` zeigt das AN-2-Risiko am Trackende: der Ein-URI-Kontext startet hörbar neu, bevor der Override greift.
