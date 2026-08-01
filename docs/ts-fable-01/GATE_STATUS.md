# Gate-Status — TS-FABLE-01

Stand: 2026-08-01 (§A-Abschluss + Phase 4) · Regel: `BLOCKED` ist kein Release-PASS.

| Gate | Inhalt | Status | Nachweis |
|---|---|---|---|
| G0 Re-Audit | BASE-01…BASE-06 | **PASS** | `PHASE0_REAUDIT.md` |
| G1 UX-Konzept | 3 Single-Source-Konzepte, Source Manifest, unabhängiger Review | **PASS** | ADR-001, UX_SOURCE_MANIFEST.md; 123/123 Einträge gelesen; Fremdmodell-Review mit nachgerechneten Kontrasten; Auflagen in ADR-001 §Auflagen (fließen als Pflichtspezifikation in G2) |
| G2 UX-Implementierung | Pflicht-Screen-Set, responsive, A11y, Browserbelege | **PASS** | Commits `50703cf`…`4f8e386`; unabhängige Browser-Suite `tests/browser/` (46 Tests zum G2-Zeitpunkt: Flows, echter Drift, Keyboard, Touch-Ziele, Overflow 320–1280, Reduced Motion, Theme-Matrix, A11y-Struktur, 80 Kontrast-Stichproben) **46/46 grün** nach Fix-Pass (die Suite ist seither mit den §A-UI-Tests auf **54** gewachsen — s. G4/G5, KP-1); QA-Blocker (ungelabelte Radios, Banner-Kontrast Light, Mobil-Nav) behoben und durch die unveränderte Suite verifiziert. Ehrliche Restnotizen: „gestoppt"-Status, mehrere Live-Runs je Playlist, Regel-Editor, Sync und Config-Funktionen sind deklarierte Vorschau bis zum Phase-3-Backend; Track-Metadaten im Verlauf folgen mit v3-Schema; Spotify-Attribution live erst mit Credentials prüfbar. |
| G3 Spotify-Forensik & Strategie | Repro, ≥2 Strategien, ADR, Regressionstest rot→grün | **PASS (automatisiert) / Live-Zeilen BLOCKED** | Commits `a7b060a`→`fdb06ec`. SP-001…SP-005, SP-007, SP-008: `VERIFIED_AUTOMATED` (Simulator mit deklarierten AN-1…AN-7, adversarial verifiziert; SP-008 als strict-xfail rot bewiesen und nach ADR-002-Umsetzung regulär grün). SP-006: automatisiert abgedeckt; Neustart-Restwissen (`window_anchor` prozesslokal → einmaliger hörbarer Titel-Restart) dokumentiert, durables Dedup folgt mit Schema v3. Live-Bestätigung aller SP-Zeilen: BLOCKED (LT-1…LT-13, `LIVE_TEST_GUIDE.md`). |
| G4 Spotify-Use-Cases | UC-01…UC-30, Migrationen, Tests | **PASS (automatisiert) / Live BLOCKED** | `UC_EVIDENCE_MATRIX.md` §A-Abschluss + Runde-2-adversarial verifiziert (6 Linsen, alle Widerlegungen B1–B11 eingearbeitet, u. a. der kritische Fast-Path-Gap-Bug): **28 UC + 11 RUN PASS(automated)**, 2 UC + 1 RUN TEILWEISE — die drei tragen dieselbe bewusste, end-to-end gepinnte No-Repeat-Endgame-Ausnahme (UC-06/24, RUN-03), 0 NEIN. Alle sechs früheren TEILWEISE-UCs und RUN-02 geschlossen (Fenster-Re-Assert/ADR-004, UC-24-Reopen, UC-07/08/21-UI+API, UC-22-Zählentscheidung, Restart-E2E, apply-sync-HTTP). Live durchgängig BLOCKED (LT-1…14). Migrationen v3+M011 mit Rollback-Doku (M009 gated). |
| G5 Hardening | Testmatrix, Security/Privacy, Evidence Matrix, Release-Review | **PASS (automatisiert) mit 2 Doku-Auflagen / Live BLOCKED** | ERR-01…08 + MAN-01…05 abgedeckt (`ERR_MAN_COVERAGE.md`, 36 Tests, 4 Funde gefixt); unabhängiger Security-Review (20 Findings, `SECURITY_PRIVACY_STATUS.md`) — alle 5 blockierenden Auflagen behoben+getestet (`07d5575`); Disconnect-Löschpfad F10 dreistufig (`retention.py`); 10k-Performance (Replan 54,6→1,4 s); Concurrency/Locking + Flakiness-Wurzel behoben; Policy-/Kommerz-Status. **Unabhängiger Release-Gesamt-Review: PASS(automated) mit Auflagen** — 0 Blocker, Suiten/Migrationen/Secrets/Live-Ehrlichkeit selbst reproduziert; AUF-1 (Browsermatrix Chromium-only) und AUF-2 (Matrix-Kopfzahl) als Doku-Auflagen eingearbeitet (Querschnittsnotiz 15, Kopfzeile 704/`aa64e7b`). Suiten: **704 Unit/API + 54 Browser (nur Chromium) + 8 slow grün, Ruff clean.** Live-Zeilen BLOCKED. |
| G6 Optionale Provider | Capability Matrix, nur nach G1–G5-PASS (Live zählt nicht als PASS) | OFFEN — bleibt gesperrt, solange das Spotify-Live-Gate BLOCKED ist | — |

## Bekannte externe Blocker (Stand Phase 0)

| Blocker | Betroffen | Exakte Voraussetzung zur Auflösung |
|---|---|---|
| Keine Live-Credentials | alle `VERIFIED_LIVE`-Zeilen in G3–G5 | Spotify-App-Client-ID (Dev Mode, Premium-Owner) + dediziertes Premium-Testkonto (als App-Nutzer eingetragen) + reales aktives Gerät + `.env` gemäß `.env.example` |
| Kommerzielle Zulässigkeit | Launch-/Pricing-Claims | Streaming-SDA-Einstufung (Policy IV.2): kommerzielle Nutzung ohne Spotify-Sondervereinbarung nicht gestattet; juristische/fachliche Prüfung vor jedem kommerziellen Claim |

## Phasenplan (verbindliche Reihenfolge)

1. **Phase 1 (G1+G2):** Ist-Inventar → Mika-Retrieval mit harten Produktfiltern → 3 unabhängige Single-Source-Konzepte → Auswahl durch Lead → unabhängiger Opus-Review → Implementierung aller Pflichtflows → Browser-/Screenshot-/Keyboard-/A11y-Abnahme.
2. **Phase 2 (G3):** Instrumentierung + Repro (live BLOCKED → simulationsgestützte Codebelege + redigierte Live-Anleitung) → Strategievergleich (Kandidaten A–D aus Handoff **plus** `uris`-Fenster-Play aus BASE-05) → ADR → Regressionstest rot→grün → idempotentes Command-/Event-Modell.
3. **Phase 3 (G4):** Domänenmodell + versionierte Migrationen (u. a. Ablösung `idx_runs_one_live`) → UC-01…30 → Produktentscheidungen aus 09 als ADRs → Unit/Property/Integration/Concurrency-Tests.
4. **Phase 4 (G5):** volle Akzeptanzmatrix, MAN/ERR-Zeilen, Security/Privacy (inkl. 5-Tage-Löschpflicht), Performance 10k, unabhängiger Release-Review; Live-Zeilen ehrlich BLOCKED mit Anleitung.
5. **Phase 5 (G6, optional):** Capability Matrix Apple/YouTube/Demo; nur nach vollständigem G1–G5-PASS.
