# RUN_STATE — TS-FABLE-01 (Wiederaufnahme-Checkpoint)

**Zweck:** Nach einem Session-/Limit-Abbruch hier weiterlesen statt Kontext teuer zu rekonstruieren. Wird bei jedem Meilenstein aktualisiert und gepusht.

Letzte Aktualisierung: 2026-07-31 ~18:40 UTC · Branch `claude/true-shuffle-fable5-run-z2eqzb` · HEAD siehe git log.

## Gate-Stand (Details: GATE_STATUS.md)

- G0 ✅ · G1 ✅ · G2 ✅ (Browser-Suite 46/46) · G3 ✅ automatisiert / Live BLOCKED (LT-1…13) · G4 IN ARBEIT · G5/G6 offen.

## Phase 3 — Arbeitspaket-Stand

| WP | Inhalt | Stand |
|---|---|---|
| WP3-A | Schema v3 + Migrations-Runner M001–M010 (M009 gated) | ✅ committed `70d7b81`, 441 Tests grün |
| ADR-003 | 10 Produktfragen entschieden | ✅ `2b74e2e` |
| WP3-C | Reine Auswahl-Engine core/selection.py nach Vertrag `worknotes/WP3C_SELECTION_CONTRACT.md` | 🔄 Agent läuft (nach Limit-Abbruch fortgesetzt; Tree war sauber) |
| WP3-D1 | Import/Snapshot/Sync-Dienst (UC-03/04) — app/library_service.py, API, minimale library.html-Verdrahtung | 🔄 Agent läuft (Neustart nach transientem Fehler) |
| WP3-D2 | Run-Lifecycle v3: explizite Run-ID statt find_live_run-Auto-Resume, Stop/Reset(cycle++)/Archiv-Delete, mehrere Runs, Export v3, latest_completed_order auf (Playlist,Config) einschränken, previous()=Replay | ⏳ nach D1 |
| WP3-D3 | Selection-Integration (run_plan/run_selections, deterministische event_keys F5), Configs/Favoriten/Ausschlüsse-API, Skip-/Manual-Use-/NewTracks-Policies (F8-Zustandsautomat im Watcher), apply_sync_to_run | ⏳ nach C+D2 |
| WP3-D4 | Frontend-Verdrahtung: Builder/Configs echt statt Vorschau, Dashboard mehrere Runs, Player Policy-UI/Zustand C, Progress/History mit Trackdaten | ⏳ nach D3 |
| WP3-E | Unabhängige Property-Tests (Opus, P1–P8 aus Vertrag) + Review + UC-Evidence-Matrix | ⏳ nach C…D4 |

## Nächste Schritte (wenn hier wieder aufgesetzt wird)

1. `git log --oneline -10` + `git status` prüfen; laufende Agent-Ergebnisse ggf. im Tree.
2. `python -m pytest -q` (Erwartung ≥441 grün) und bei App-Änderungen `python -m pytest tests/browser -m browser -q` (46).
3. Offene WPs gemäß Tabelle oben in Reihenfolge D1→D2→D3→D4→E vergeben; Verträge/Blueprints liegen in `docs/ts-fable-01/worknotes/`.
4. Nach jedem grünen WP: committen, pushen, DIESE Datei aktualisieren.

## Wichtige Orte

- Blueprints/Verträge: `docs/ts-fable-01/worknotes/` (Domänenanalyse, Selection-Vertrag, UX-Verträge, Phase-2-Plan, Messmatrix).
- ADRs: `docs/ts-fable-01/adr/` (001 UX, 002 Ausführungsstrategie, 003 Produktfragen).
- Live-Gate: `LIVE_TEST_GUIDE.md` (BLOCKED; Voraussetzungen in GATE_STATUS.md).
- Model Ledger: `MODEL_LEDGER.md` (Erzeuger≠Abnehmer-Nachweise).
- Private Provenienz (Mika-Library): NICHT im Repo; Kopie im privaten Drive des Nutzers (Ordner „True Shuffle – Arbeitsnachweise"), Original im Session-Scratchpad.

## Arbeitsregeln-Merker

Kleine thematische Commits; Teständerungen nur mit ADR-Begründungskommentar; keine Secrets; Erzeuger≠Abnehmer; BLOCKED ehrlich führen; Agenten committen nicht selbst — Lead reviewt, committet, pusht, aktualisiert RUN_STATE.
