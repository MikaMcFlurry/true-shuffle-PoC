# HANDOFF_CONTINUATION — TS-FABLE-01 Fortsetzung in frischer Session

Stand: 2026-08-01 · Branch `claude/true-shuffle-fable5-run-z2eqzb` · Zweck: Eine NEUE Session setzt hier verlustfrei auf, ohne den alten Chatverlauf zu laden. Dieses Dokument + die verlinkten Repo-Dateien sind der vollständige Kontext.

## Direkt kopierbarer Startprompt für die neue Session

```text
Du bist der Lead-Orchestrator für den True-Shuffle-Lauf TS-FABLE-01 (Fortsetzung).
Repo: MikaMcFlurry/true-shuffle-PoC, Branch claude/true-shuffle-fable5-run-z2eqzb.
Lies ZUERST vollständig: docs/ts-fable-01/HANDOFF_CONTINUATION.md — es enthält Stand,
Regeln und die restliche Aufgabenliste. Folge ihm. Arbeite autonom weiter, committe
und pushe kleine thematische Commits, aktualisiere RUN_STATE.md bei jedem Meilenstein.
Beginne mit dem Abschnitt „Nächste Aufgaben in Reihenfolge".
```

## Wo alles liegt (Leseliste für die neue Session, in dieser Reihenfolge)

1. **Dieses Dokument** — Aufgaben + Regeln.
2. `RUN_STATE.md` — aktueller WP-Stand (wird fortgeschrieben; maßgeblich bei Konflikt mit diesem Dokument).
3. `GATE_STATUS.md` — Gate-Historie G0–G6 mit Evidenz; `UC_EVIDENCE_MATRIX.md` — UC-01–30/RUN-01–12-Belege.
4. `adr/ADR-001..003` — UX-Richtung „Nachtpult", uris-Fenster-Strategie, 10 Produktentscheidungen.
5. `worknotes/` — Blueprints: Domänenanalyse (v3-Schema), Selection-Vertrag (P1–P8 + Semantikentscheidungen), UX-Verträge, Phase-2-Plan, Strategie-Messmatrix.
6. `LIVE_TEST_GUIDE.md` — redigierte Live-Testanleitung (Gate BLOCKED, LT-1…LT-13).
7. `MODEL_LEDGER.md` — Modell-Routing + Erzeuger≠Abnehmer-Protokoll (fortschreiben!).
8. Original-Handoff `handoffs/TS-FABLE-01/` — nur bei Bedarf (Akzeptanzmatrix 08, UCs 03A).

Privater Provenienz-Nachweis (Mika-Library-IDs/Hashes): NICHT im Repo; liegt im privaten Google Drive des Nutzers („TS-FABLE-01 – Privater Arbeitsnachweis UX-Provenienz"). Keine Library-IDs/Hashes ins Repo.

## Kurzstand (was fertig ist)

- **G0–G3 PASS** (G3 automatisiert; Live durchgängig BLOCKED — keine Credentials/Gerät). Queue-Bug bewiesen und per ADR-002 (uris-Fenster) behoben; SP-008 rot→grün.
- **Phase 3 implementiert:** Schema v3 + Migrations-Runner (M009 gated), Import/Snapshot/Sync, Run-Lifecycle v3 (Stop/Reset/Delete, mehrere Runs je Playlist), Selection-Engine (unabhängige Property-Suite: 9 Funde → alle gefixt, xfails geflippt), Selection-Ledger + F5-event_keys, F8-Manual-State-Machine, Configs/Favoriten/Ausschlüsse, Frontend-Vollverdrahtung. Suiten: **614 Unit/API + 50 Browser + 8 slow, alles grün; Ruff clean.**
- **Evidence-Matrix** gebaut und adversarial geprüft (Korrekturen der 3 Prüf-Linsen eingearbeitet — siehe UC_EVIDENCE_MATRIX.md §Unabhängige Verifikation). Ergebnis: 25 UC PASS(automated), 5 TEILWEISE, RUN-01–12 PASS(automated), Live überall BLOCKED.

## Nächste Aufgaben in Reihenfolge

### A. Phase-3-Rest (6 TEILWEISE-UCs + 2 RUN-Zeilen schließen; Details je Zeile in UC_EVIDENCE_MATRIX.md) — je klein, einzeln committen
1. **Fenster-Re-Assert (Code, prioritär):** Exclude/Reaktivieren/Regeländerung während aktiver Wiedergabe müssen das uris-Fenster neu setzen (`_window_anchors`-Re-Assert in den betroffenen Pfaden) — Matrix stuft UC-20/27/RUN-08 sonst als hohes Live-Divergenzrisiko ein. Mit Test über den Watcher-Pfad (Simulator).
2. **UC-22:** Tests für `db.deck_stats` (repeat_count/excluded_count) + `skipped_count`/`progress_pct`-Assertions; Zählsemantik von `repeats` festlegen (Karten vs. Vorgänge) und dokumentieren.
3. **UC-21:** UI-Weg zum Reaktivieren (Ansicht ausgeschlossener Titel + Knopf; API existiert) + Browser-Test.
4. **UC-08:** `favorite_weight` im Builder/Config-Editor einstellbar (Backend existiert) + Browser-Test.
5. **UC-07:** Lead-Entscheidung per-Track-Gewichte: kleine API+UI ODER ehrlich aus dem Builder-Versprechen nehmen.
6. **UC-24:** Completion-Folgeaktionen entstören — „Neuer Durchlauf" nach Abschluss darf nicht am Playing-Slot-409 scheitern (Matrix R2); Flow-Test.
7. **UC-19-Textfix:** Builder-Text requeue_later an echte Semantik anpassen (später Skip → Folgezyklus).
8. **RUN-02/UC-30:** Dauerhafter Restart-E2E gegen echte DB+App (nicht nur Bench): anlegen → hören → Prozess-Neustart → fortsetzen → abschließen (Demo-Provider, Browser oder TestClient mit neuem App-Kontext).
9. **RUN-09/UC-25:** HTTP-Ebenen-Test für POST /api/runs/{id}/apply-sync; LIVE_TEST_GUIDE um LT-Abschnitt „Ausschluss/Regeländerung während Wiedergabe" ergänzen.
10. Danach: **G4-Eintrag aktualisieren** (Ziel: PASS(automated) ohne TEILWEISE-Zeilen, Live weiter BLOCKED), RUN_STATE + MODEL_LEDGER fortschreiben.

### B. Phase 4 — Hardening & Abnahme (08_ACCEPTANCE_TEST_MATRIX.md vollständig)
1. **ERR-01…08**: gezielte Tests (kein Gerät, Premium fehlt/402, 401/Refresh, 429 Retry-After, 5xx/Timeout-Backoff, Track unverfügbar, Disconnect, DB/Prozess-Restart ohne halbe Transitionen). Simulator + Fakes; Live-Zeilen BLOCKED mit LT-Verweis.
2. **MAN-01…05**: automatisiert über F8-Tests abdecken/erweitern (alle 3 Policies × 5 Aktionen, soweit simulierbar), Live BLOCKED.
3. **Security/Privacy-Review** (unabhängiger Opus-Lauf, kein Implementierungskontext): OAuth/state, TokenVault, Logs ohne Secrets, CSRF, Ownership; **Disconnect-Löschpfad implementieren** (deletion_requests-Job: 3-Stufen-Modell aus ADR-003/F10, 5-Tage-Frist testbar) — das ist noch NICHT implementiert, nur die Tabelle existiert.
4. **Performance 10k-Tracks**: Profil (Import, Plan-Materialisierung, select-Query, /api/runs/{id}-Latenz, Pagination) + Befund dokumentieren.
5. **Concurrency/Locking**: parallele Requests + Watcher (advance_lock), Browser-Vollsuite-Fixture-Flakiness untersuchen (RUN_STATE-Notiz); box-sizing-Global-Befund aus D4 prüfen.
6. **Policy-/Commercial-Status** dokumentieren (Phase-0-Fakten: Streaming SDA ⇒ kommerziell nicht ohne Sondervereinbarung; KEINE Compliance-Claims).
7. **Abschlussartefakte**: Testberichte generieren, redigierter Live-Testbericht (= LIVE_TEST_GUIDE + „nicht ausgeführt/BLOCKED"-Formular), Migrations-/Rollback-Doku prüfen (app/migrations.py-Docstrings), Abschlussbericht mit Commit-Übersicht, Model Ledger final, BLOCKED/FAIL-Liste.
8. **G5-Gate-Entscheidung** durch unabhängigen Release-Review (Opus) + Lead.

### C. Phase 5 (optional, NUR nach G1–G5 und ausdrücklich laut Handoff erst wenn Spotify vollständig PASS — Live-BLOCKED zählt NICHT als PASS)
→ Capability-Matrix Apple/YouTube/Demo. Realistisch: bleibt offen, bis Live-Gate entsperrt ist. Nicht beginnen.

### Dauerhaft BLOCKED bis Nutzer liefert
Spotify-App-Client-ID + dediziertes Premium-Testkonto + reales Gerät (Details GATE_STATUS §Blocker). Dann: LIVE_TEST_GUIDE LT-1…13 ausführen, AN-1/2/5/6/7 bestätigen, SP/UC-Live-Spalten aktualisieren.

## Arbeitsregeln (unverändert verbindlich)

- Kleine thematische Commits, sofort pushen; **RUN_STATE.md bei jedem Meilenstein aktualisieren** (Limit-Abbruch-Resilienz!). Agenten committen nicht; Lead reviewt/committet. Grüne Zwischenstände sofort sichern.
- Erzeuger ≠ Abnehmer bei kritischer Arbeit (Model Ledger fortschreiben; Muster: Fable implementiert, Opus verifiziert adversarial).
- Teständerungen nur mit ADR-Begründungskommentar; Ehrlichkeits-Semantik nie schwächen; keine Secrets; BLOCKED ehrlich führen; kein Merge/Deploy ohne Freigabe; kein Live-PASS aus Fakes.
- Agenten-Briefings: wertvollste Datei zuerst schreiben; nach jedem Block testen; bei Session-Limit-Abbruch via SendMessage mit erhaltenem Kontext fortsetzen (Tree-Stand vorher prüfen).
- Token-Sparsamkeit: Blueprints/Verträge aus `worknotes/` referenzieren statt Kontext neu herzuleiten; Subagenten lesen Dateien selbst (Pfade übergeben, keine Inhalte einbetten); Workflows nur wo Fan-out echten Wert hat.

## Umgebung (Kurzreferenz)

Python 3.11, `pip install -r requirements.txt` (+hypothesis in Dev-Sektion). Tests: `python -m pytest -q` (Default exkludiert browser+slow), `python -m pytest tests/browser -m browser -q` (braucht ENABLE_DEMO_PROVIDER=true als Shell-Env — NICHT in .env schreiben, bricht einen Test; Chromium: /opt/pw-browsers/chromium), `python -m pytest -m slow -q`. Ruff: `python -m ruff check .`. App-Demo: uvicorn mit ENABLE_DEMO_PROVIDER=true. `.env` existiert lokal (SECRET_KEY/DB-Pfad), ist git-ignoriert.
