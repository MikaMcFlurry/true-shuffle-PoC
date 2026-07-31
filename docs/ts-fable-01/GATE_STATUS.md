# Gate-Status — TS-FABLE-01

Stand: 2026-07-31 · Regel: `BLOCKED` ist kein Release-PASS.

| Gate | Inhalt | Status | Nachweis |
|---|---|---|---|
| G0 Re-Audit | BASE-01…BASE-06 | **PASS** | `PHASE0_REAUDIT.md` |
| G1 UX-Konzept | 3 Single-Source-Konzepte, Source Manifest, unabhängiger Review | **PASS** | ADR-001, UX_SOURCE_MANIFEST.md; 123/123 Einträge gelesen; Fremdmodell-Review mit nachgerechneten Kontrasten; Auflagen in ADR-001 §Auflagen (fließen als Pflichtspezifikation in G2) |
| G2 UX-Implementierung | Pflicht-Screen-Set, responsive, A11y, Browserbelege | OFFEN | — |
| G3 Spotify-Forensik & Strategie | Repro, ≥2 Strategien, ADR, Regressionstest rot→grün | OFFEN | — |
| G4 Spotify-Use-Cases | UC-01…UC-30, Migrationen, Tests | OFFEN | — |
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
