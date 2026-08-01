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
| WP3-C | Reine Auswahl-Engine core/selection.py nach Vertrag `worknotes/WP3C_SELECTION_CONTRACT.md` | ✅ committed `7452790`, 57 Tests; Angriffspunkte für Property-Lauf im Agentenbericht (Quota-Fenster, Relaxations-Kanten, Float-Gewichte, P1×keep_open) |
| WP3-D1 | Import/Snapshot/Sync-Dienst (UC-03/04) — app/library_service.py, API, minimale library.html-Verdrahtung | ✅ final in `9b10db8` (WIP-Commit = Endstand; 10 Service-Tests, 4 API-Routen, apply_sync_to_run-Vertrag für D3 im Docstring fixiert). Phase-4-Notiz: Browser-Vollsuite zeigt sporadische Fixture-Setup-Flakiness bei Ganz-Modul-Läufen (Einzelläufe grün). |
| WP3-D2 | Run-Lifecycle v3: explizite Run-ID, Stop/Resume (F1), Reset=Zyklus (F2), Soft/Hard-Delete (UC-26), Import→unabhängiger Run, Guard-Scoping, previous=Replay, run_tracks/run_plan-Materialisierung | ✅ committed `fa19bc4`, 525 Tests, 0 Bestandstest-Änderungen. Bekannt: Takeover-Browser-Fixture kollidiert mit idx_runs_one_playing (2. Controller-Run startet jetzt paused) — wird durch F8-Zustandsautomat in D3 gelöst, danach Browser-Fixture anpassen. advance() verbucht noch nicht in run_tracks/run_plan (D3); reset für Legacy-Import-Runs ohne Deck verweigert ehrlich. |
| WP3-D3 | Selection-Ledger + F5-event_keys, F8-Manual-State-Machine (inkl. Zustand-C-API), Config-CRUD/Versionierung/effective_from, Favoriten/Ausschlüsse, Preflight, apply_sync (alle 3 Policies) | ✅ committed `2ad8069`; 551 Unit/API + 46/46 Browser (Takeover-Fixture auf F8 umgestellt); zwei Limit-Abbrüche überstanden, Endstand vom Lead verifiziert |
| WP3-D4 | Frontend-Verdrahtung: Builder/Configs echt statt Vorschau, Dashboard mehrere Runs, Player Policy-UI/Zustand C, Progress/History mit Trackdaten | ⏳ nach D3 |
| WP3-E1 | Unabhängige Property-Tests (Opus): 9 Verletzungen gefunden (`1a8de05`), alle per separatem Fix-Lauf geschlossen — 13 strict-xfails zu Passes geflippt (`55550f3`, 612 passed) | ✅ |
| WP3-E2 | Adversarialer Gesamt-Review + UC-01–30-Evidence-Matrix + G4-Gate | ⏳ nach D4 |

**Offene Punkte für Phase-3-Abschluss/E2:** (a) Verbuchungspfad stempelt `last_played_seq` bei Skips nicht — Engine-Requeue-Frist greift produktiv erst nach diesem Stempel (Vertragslücke dokumentiert in WP3C_SELECTION_CONTRACT); (b) M009 (order_json-Drop) bleibt gated bis v3-Pfad produktiv bestätigt; (c) 3 E501 in tests/browser/test_phase3_flows.py (D4-in-flight).

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
