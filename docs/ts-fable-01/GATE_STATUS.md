# Gate-Status — TS-FABLE-01

Stand: 2026-07-31 · Regel: `BLOCKED` ist kein Release-PASS.

| Gate | Inhalt | Status | Nachweis |
|---|---|---|---|
| G0 Re-Audit | BASE-01…BASE-06 | **PASS** | `PHASE0_REAUDIT.md` |
| G1 UX-Konzept | 3 Single-Source-Konzepte, Source Manifest, unabhängiger Review | **PASS** | ADR-001, UX_SOURCE_MANIFEST.md; 123/123 Einträge gelesen; Fremdmodell-Review mit nachgerechneten Kontrasten; Auflagen in ADR-001 §Auflagen (fließen als Pflichtspezifikation in G2) |
| G2 UX-Implementierung | Pflicht-Screen-Set, responsive, A11y, Browserbelege | **PASS** | Commits `50703cf`…`4f8e386`; unabhängige Browser-Suite `tests/browser/` (46 Tests: Flows, echter Drift, Keyboard, Touch-Ziele, Overflow 320–1280, Reduced Motion, Theme-Matrix, A11y-Struktur, 80 Kontrast-Stichproben) **46/46 grün** nach Fix-Pass; QA-Blocker (ungelabelte Radios, Banner-Kontrast Light, Mobil-Nav) behoben und durch die unveränderte Suite verifiziert. Ehrliche Restnotizen: „gestoppt"-Status, mehrere Live-Runs je Playlist, Regel-Editor, Sync und Config-Funktionen sind deklarierte Vorschau bis zum Phase-3-Backend; Track-Metadaten im Verlauf folgen mit v3-Schema; Spotify-Attribution live erst mit Credentials prüfbar. |
| G3 Spotify-Forensik & Strategie | Repro, ≥2 Strategien, ADR, Regressionstest rot→grün | **PASS (automatisiert) / Live-Zeilen BLOCKED** | Commits `a7b060a`→`fdb06ec`. SP-001…SP-005, SP-007, SP-008: `VERIFIED_AUTOMATED` (Simulator mit deklarierten AN-1…AN-7, adversarial verifiziert; SP-008 als strict-xfail rot bewiesen und nach ADR-002-Umsetzung regulär grün). SP-006: automatisiert abgedeckt; Neustart-Restwissen (`window_anchor` prozesslokal → einmaliger hörbarer Titel-Restart) dokumentiert, durables Dedup folgt mit Schema v3. Live-Bestätigung aller SP-Zeilen: BLOCKED (LT-1…LT-13, `LIVE_TEST_GUIDE.md`). |
| G4 Spotify-Use-Cases | UC-01…UC-30, Migrationen, Tests | **TEILWEISE (automatisiert) / Live BLOCKED** | `UC_EVIDENCE_MATRIX.md` (adversarial verifiziert, 3 Linsen, Korrekturen eingearbeitet): 24 UC + 10 RUN-Zeilen PASS(automated), 6 UC + 2 RUN TEILWEISE mit exakt benannten Lücken (UC-07/08/21/22/24/30, RUN-02/03), 0 NEIN; Live durchgängig BLOCKED (LT-1…13). Migrationen v3 mit Rollback-Doku (`app/migrations.py`, M009 gated). Restarbeiten in `HANDOFF_CONTINUATION.md` §A. Drei Zeilen mit hohem Live-Divergenzrisiko markiert (Fenster-Re-Assert bei Exclude/Regeländerung — Code-Folgepunkt). |
| G5 Hardening | Testmatrix, Security/Privacy, Evidence Matrix, Release-Review | OFFEN | — |
| G6 Optionale Provider | Capability Matrix, nur nach G1–G5-PASS | OFFEN | — |

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
