# RUN_STATE — TS-FABLE-01 (Wiederaufnahme-Checkpoint)

**Zweck:** Nach einem Session-/Limit-Abbruch hier weiterlesen statt Kontext teuer zu rekonstruieren.

Letzte Aktualisierung: 2026-08-01 (§A-Abschluss + Phase 4 weitgehend) · Branch **`claude/true-shuffle-fable5-lead-928f25`** (mandatiert; `run-z2eqzb` war beim Start identisch, wird nicht mehr fortgeschrieben) · HEAD siehe git log.

## Gate-Stand (Details: GATE_STATUS.md)

- G0 ✅ · G1 ✅ · G2 ✅ · G3 ✅ automatisiert / Live BLOCKED · **G4 ✅ PASS(automated)** (§A abgeschlossen, Runde-2-adversarial verifiziert) / Live BLOCKED · **G5 TEILWEISE** (ERR/MAN + Security + Perf + Concurrency erledigt; offen: unabhängiger Release-Gesamt-Review + Abschlussbericht) · G6 gesperrt bis Spotify-Live-PASS.

## Suiten-Stand (auf HEAD vom Lead ausgeführt)

- **704 Unit/API/Property/Sim** (`python -m pytest -q`), **54 Browser** (`ENABLE_DEMO_PROVIDER=true … tests/browser -m browser`), **8 slow**, **Ruff clean**.

## Was in dieser Fortsetzungssession geschah (Commit-Übersicht)

| Commit | Inhalt |
|---|---|
| `c86ed42` | ADR-004 Fenster-Re-Assert (UC-20/27/RUN-08, prioritär) + Watcher-Selbstheilung; rot-vor-Fix-Suite |
| `b856d0e`/`a97987c` | §A-Backend: UC-24-Reopen, UC-07-Gewichts-API, UC-22-Zählsemantik, Deck-Listing-Route |
| `6d45dee` | F10 dreistufiger Disconnect-Löschpfad (ERR-07) + M011 |
| `16a12b1`→`5b7ae8a` | Replan-Fast-Path (10k: 54,6→1,4 s) — **B1-Gap-Bug in `5b7ae8a` gefixt** |
| `7ae2520` | §A-UI-Paket (Reaktivieren, Favoriten-Vorrang, Pro-Titel-Gewicht, requeue-Text) |
| `71b2aa9` | Concurrency-Suite + Lock-Leak-Flakiness-Fix |
| `7ee535a`/`67e4009` | ERR/MAN-Matrix (36 Tests) + 4 Funde gefixt (Geräteklasse, playback_failed, Positionstreue, Gerätefolge) |
| `0610b67`/`8ae8741` | Runde-2-Befunde B2/B4/B5/B6/B8 geschlossen + Matrix korrigiert |
| `07d5575` | 5 blockierende Security-Auflagen (SEC-01/03/04/05/06/07/09/12/13/14/16/17) |
| docs | Live-Guide LT-13/14, Perf-Profil, ERR/MAN-Coverage, Policy-Status, Security-Status, Ledger, Matrix, Gate |

## Nächste Aufgaben in Reihenfolge

1. **Abschlussartefakte (Phase 4 §B7):** Abschlussbericht mit Commit-Übersicht, redigierter Live-Testbericht-Status (= LIVE_TEST_GUIDE + „nicht ausgeführt/BLOCKED"-Formular), BLOCKED/FAIL-Liste, Migrations-/Rollback-Doku-Prüfung. → teilweise erledigt (dieser Checkpoint + Statusdocs).
2. **G5-Gate-Entscheidung** durch unabhängigen Release-Gesamt-Review (Opus, kein Implementierungskontext) — der letzte offene G5-Punkt.
3. **Dauerhaft BLOCKED:** Live-Gate (Spotify-Credentials + Premium-Testkonto + reales Gerät). Dann LIVE_TEST_GUIDE LT-1…14 ausführen, Live-Spalten aktualisieren.
4. **Nicht beginnen:** Phase 5 (weitere Provider) — regelkonform gesperrt bis Spotify-Live-PASS.

## Offene, bewusst dokumentierte Restpunkte (kein Statusverlust)

- No-Repeat-Endgame-Ausnahme (UC-06/24, RUN-03 TEILWEISE) — bewusst, getestet, Builder-Text ehrlich.
- Security-Restrisiken für eine ÖFFENTLICHE Version (SEC-02/08 Cookie-Identität, SEC-10 Rate-Limiting, SEC-11/18/19/20) — in `SECURITY_PRIVACY_STATUS.md`; Beta-tauglich mit starkem `ACCESS_CODE`.
- Gewichteter Replan bleibt O(n²) (Perf-Worknote) — G5-Folgeoption.
- `signout`→POST, Full-Delete-UI — Kleinpunkte.

## Arbeitsregeln-Merker

Kleine thematische Commits; Teständerungen nur mit Begründungskommentar; keine Secrets; Erzeuger≠Abnehmer; BLOCKED ehrlich führen; kein Merge/Deploy ohne Freigabe; kein Live-PASS aus Fakes.
