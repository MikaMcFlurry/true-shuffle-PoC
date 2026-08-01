# Phase-4-Performance-Profil — 10 000 Tracks

Datum: 2026-08-01 · Methode: In-Process-Profil (Skript im Session-Scratchpad)
gegen FakeProvider mit realistischer Seitengröße 100, SQLite auf Disk.
Zahlen sind Größenordnungen dieser Umgebung, keine Produktions-Benchmarks.

## Messwerte

| Pfad | vor Fix | nach Fix | Einordnung |
|---|---|---|---|
| Import 10k (`import_playlist`) | 11,8 s | 9,9 s | läuft als Job mit Fortschritt (202 + Polling) — akzeptabel; Netz-Roundtrips dominieren live |
| Run anlegen (`create_run_v3`, Deck + Plan materialisieren) | 3,1 s | 2,0 s | läuft als Job — akzeptabel |
| Start / Advance ×5 / describe / deck_stats / Events | ≤ 60 ms | ≤ 60 ms | unkritisch |
| `list_run_tracks` (10k Zeilen) | 79 ms | 81 ms | ok; UI paginiert ohnehin |
| **Tail-Replan** (`change_run_rules`, ebenso Ausschluss/apply-sync) | **54,6 s** | **1,4 s** | war der einzige rote Befund — Details unten |
| DB-Größe nach Lauf | 4,5 MB | 4,5 MB | unkritisch |

## Befund und Fix (Tail-Replan)

Der no_repeat-Replan zog den vollen `select_next`-Draw-Loop über alle
offenen Karten: O(n²), 54,6 s bei 10k — **unter dem `advance_lock`**, d. h.
Watcher und Wiedergabesteuerung standen für die Dauer still; ausgelöst
bereits von einem einzelnen Titel-Ausschluss. Fix: im reinen Fall (nur
offene Karten, keine deferred-Fristen, keine Favoriten/Gewichte) ist der
Loop distributionsgleich mit einer geseedeten Permutation —
`_replan_tail` delegiert dann an `plan_cycle` (O(n log n), identische
P1/P5-Garantien, Determinismus über `draw_seed(master_seed, seq+1)`).
Fristen (P6) und Gewichtung (P4) erzwingen weiter den Draw-Loop —
gepinnt in `tests/test_replan_fastpath.py` (u. a.: der reine Fall darf
`select_next` nachweislich nie aufrufen).

## Restbefunde (dokumentiert, nicht kritisch)

- Der GEWICHTETE no_repeat-Replan (Favoriten/Pro-Titel-Gewichte gesetzt)
  bleibt O(n²). Bei 10k mit Favoriten wäre der Replan weiterhin ~1 min.
  Folgeoption für G5: Horizont-begrenzter gewichteter Replan (PLAN_HORIZON)
  mit Verlängerung am Planende — erfordert eine bewusste Vertragsänderung
  (Vollpermutations-Zusage der Replans) und ist NICHT Teil dieses Fixes.
- Import-/Run-Erstellungszeiten sind Job-basiert und mit Fortschritt
  sichtbar; kein Handlungsbedarf < 50k Tracks.
