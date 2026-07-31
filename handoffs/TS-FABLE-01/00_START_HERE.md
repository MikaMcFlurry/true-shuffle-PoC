# True Shuffle – Fable Handoff TS-FABLE-01

Stand: 2026-07-31  
Ziel-Repository: `MikaMcFlurry/true-shuffle-PoC`  
Verifizierter Basis-Commit: `d626505ba63ab5a3a4d884b434bc32d58f9c0edc`  
Verifizierter Basis-Branch: `claude/true-shuffle-mvp-streaming-52jofw`  
Handoff-Branch: `handoff/fable5-true-shuffle-v1`

## Auftrag

Baue aus dem vorhandenen Multi-Provider-MVP eine belastbar funktionierende True-Shuffle-Version. Die Reihenfolge ist verbindlich:

1. UX vollständig neu konzipieren und umsetzen.
2. Spotify für die 30 definierten Use Cases funktional und live verifizieren.
3. Erst danach optional weitere Anbieter auf denselben Produktvertrag bringen.

Die aktuelle UI ist keine visuelle Grundlage. Ihre funktionalen und barrierebezogenen Erkenntnisse dürfen übernommen werden; `DESIGN.md` und die gegenwärtige Ästhetik sind für den neuen Lauf visuell ausdrücklich überholt.

## Vor dem ersten Code-Edit lesen

1. `01_VERIFIED_CURRENT_STATE.md`
2. `02_SOURCE_PRIORITY_AND_CONFLICT_RULES.md`
3. `03_PRODUCT_USE_CASES_AND_COVERAGE.md`
4. `04_UX_RENEWAL_WORK_PACKAGE.md`
5. `05_SPOTIFY_LIVE_WORK_PACKAGE.md`
6. `07_MULTI_AGENT_ORCHESTRATION.md`
7. `08_ACCEPTANCE_TEST_MATRIX.md`
8. `09_RISKS_AND_OPEN_QUESTIONS.md`

Der direkt kopierbare Orchestrator-Startprompt liegt in `10_START_PROMPT.md`.

## Nicht verhandelbar

- Nicht von `main` starten. `main` ist ein älterer Spotify-PoC.
- Das Run-Ledger von True Shuffle ist die fachliche Quelle der Wahrheit; der Spotify-Player ist ein externes, konkurrierend veränderbares Ausführungsziel.
- Unit-/Fake-Tests sind kein Nachweis für Spotify-Live-Verhalten.
- Keine Spotify-Funktion als fertig markieren, bevor sie mit einem echten Premium-Testkonto und mindestens einem realen Wiedergabegerät geprüft wurde.
- Keine Queue- oder Playback-Strategie aufgrund dieses Handoffs ungeprüft übernehmen. Die in `05_SPOTIFY_LIVE_WORK_PACKAGE.md` genannten Strategien sind Kandidaten zur Bewertung, keine Vorgaben.
- Keine UX aus mehreren Mika-Library-Einträgen verdeckt mischen. Quelle, Revision, Rollen, Gewichtung und Konfliktentscheidungen müssen nachvollziehbar sein.
- UX und Spotify müssen beide PASS sein, bevor Apple Music, YouTube Music oder weitere Anbieter ausgebaut werden.
- Keine Secrets, OAuth-Tokens, personenbezogenen Spotify-Daten oder das historische Master-Chat-DOCX committen.
- Kein Merge in einen bestehenden Produktbranch und kein Deployment ohne ausdrückliche Freigabe.

## Definition von „fertig“

„Fertig“ bedeutet nicht nur, dass Tests grün sind. Es bedeutet:

- die 30 Spotify-Use-Cases besitzen nachweisbare Akzeptanztests,
- der reale Spotify-Player verhält sich unter Start, Skip, Pause, Resume, manueller Übernahme und Gerätewechsel korrekt oder zeigt einen ehrlichen, kontrollierten Degraded State,
- keine unkontrollierten Wiederholungen durch True Shuffle entstehen,
- Nutzer können Fortschritt und Regeln dauerhaft, unabhängig vom Spotify-Zustand verwalten,
- die neue UX wurde responsiv, barrierearm und in den kritischen Flows browserbasiert geprüft,
- offene Spotify- oder Policy-Grenzen werden im Produkt nicht kaschiert,
- alle Entscheidungen, Modellzuweisungen, Testergebnisse und Rest-Risiken sind dokumentiert.

## Erwartete Ergebnisartefakte des nächsten Laufs

- eigener Implementierungsbranch auf Basis dieses Handoff-Branches,
- UX Source Manifest mit Mika-IDs, Revisionen und Auswahlbegründung,
- Architekturentscheidungen als kurze ADRs,
- Use-Case-Coverage-Matrix mit PASS/BLOCKED/FAIL und Evidenzlinks,
- automatisierte Unit-, Integrations-, Browser- und Zustandsmodelltests,
- redigierter Spotify-Live-Testbericht,
- Migrations-/Rollback-Hinweise,
- Abschlussbericht einschließlich tatsächlicher Modell- und Agentennutzung.

