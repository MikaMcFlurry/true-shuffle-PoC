# Direkt kopierbarer Startprompt für Claude Code

```text
Du bist der Lead-Orchestrator für den nächsten True-Shuffle-Produktlauf. Arbeite als Fable-5-Lead, sofern dieses Modell tatsächlich verfügbar ist; andernfalls nutze das stärkste verfügbare Orchestrationsmodell und dokumentiere den Fallback. Dein Auftrag ist nicht nur Planung, sondern die belastbare Umsetzung einer voll funktionalen Spotify-Version.

Repository:
https://github.com/MikaMcFlurry/true-shuffle-PoC

Verbindliche Basis:
- Branch: handoff/fable5-true-shuffle-v1
- Basis vor Handoff: d626505ba63ab5a3a4d884b434bc32d58f9c0edc
- Handoff-Ordner: handoffs/TS-FABLE-01

Starte so:
1. Fetch/checkout des Handoff-Branches.
2. Bestätige Commit und Repositoryzustand.
3. Lies den gesamten Ordner handoffs/TS-FABLE-01, beginnend mit 00_START_HERE.md.
4. Lies danach die relevanten aktuellen Code-, Test- und Repo-Dokumente selbst. Verlasse dich nicht nur auf Zusammenfassungen.
5. Prüfe die aktuelle Spotify-Web-API, den Februar-2026-Migrationsleitfaden, das Juli-2026-Changelog und die aktuelle Spotify Developer Policy erneut.
6. Rufe die angebundene private Mika Website/UX Library ab und verifiziere IDs, Status, Revisionen und Hashes, ohne private Library-Metadaten öffentlich zu machen.
7. Erstelle einen eigenen Implementierungsbranch von diesem Handoff-Branch. Merge oder deploye nicht ohne ausdrückliche Freigabe.

Multi-Agent-/Modellauftrag:
- Enumeriere zuerst alle tatsächlich verfügbaren Modelle und Agentenfähigkeiten.
- Wähle aus allen verfügbaren Modellen für jedes Arbeitspaket das fachlich beste Modell. Berücksichtige insbesondere Fable 5, Opus 5, Opus 4.8, Sonnet und weitere Modelle, aber erfinde keine Verfügbarkeit.
- Nutze mehrere spezialisierte Agenten. Übergib jedem Agenten exakten Scope, Use-Case-IDs, Invarianten, Dateien, erwartete Tests und Rückgabeformat.
- Erzeuger und Abnehmer kritischer Arbeit dürfen nicht derselbe Agentenlauf sein.
- Führe einen Model Ledger mit Arbeitspaket, gewähltem Modell, Begründung, Ergebnis und Reviewer.
- Nutze Modelle nicht nur zur Quote; Qualität, Unabhängigkeit und passende Fähigkeiten entscheiden.
- Du bleibst Integrator und prüfst jede Übergabe, bevor du sie übernimmst.

Verbindliche Reihenfolge:

PHASE 0 – RE-AUDIT
- Reproduziere Baseline-Tests und Lint.
- Prüfe Schema, Migrationsrisiken, aktuelle APIs/Policies und die Handoff-Befunde.
- Erstelle Gate-, Agenten- und Modellplan.

PHASE 1 – UX VOLLSTÄNDIG ERNEUERN
- Die aktuelle „Plattenschrank/Laufzettel“-UI und DESIGN.md sind visuell nicht bindend.
- Nutze die Mika Library gemäß 02_SOURCE_PRIORITY_AND_CONFLICT_RULES.md.
- Erzeuge mindestens drei klar verschiedene Single-Source-Konzepte aus aktuellen, vollständig gelesenen Library-Einträgen.
- Dokumentiere intern die exakte Library-Quelle und Revision; im öffentlichen Produkt-Repository nur einen freigegebenen Quellalias, Transferregeln und bewusst nicht übernommene Elemente. Veröffentliche keine internen Library-IDs, privaten Repository-Metadaten oder Hashes.
- Wenn Quellen gemischt werden, dokumentiere Primärquelle, Rollen, Gewichte und Konfliktentscheidungen; kein verstecktes Mischen.
- Wähle die beste Richtung für den Produktnutzen und lasse sie von einem anderen Modell auf Fidelity, Usability und Accessibility prüfen.
- Implementiere alle Pflichtflows aus 04_UX_RENEWAL_WORK_PACKAGE.md responsiv und barrierearm.
- Führe Browser-/Screenshot-/Keyboard-/Accessibility-Tests durch.
- Schließe UX mit Gate PASS ab, bevor du Spotify funktional ausweitest.

PHASE 2 – SPOTIFY LIVE-FORENSIK UND QUEUE-FIX
- Reproduziere zuerst mit Instrumentierung die vom Nutzer beobachteten Queue-Duplikate und den Fall „nach fünf vorgemerkten Titeln ist Titel 6 wieder Titel 1“.
- Trenne Beobachtung, Codebeleg, Inferenz und Live-Beweis.
- Der aktuelle Code startet einen Titel hart und hängt fünf Titel additiv an; beim Skip können Watcher/Override erneut fünf Titel anhängen. Behandle das als starke Hypothese, nicht als ungeprüfte Enderklärung.
- Vergleiche mindestens zwei tragfähige Ausführungsstrategien. Die Vorschläge in 05_SPOTIFY_LIVE_WORK_PACKAGE.md sind nur Kandidaten.
- Entscheide mit ADR anhand aller 30 Use Cases, aktueller Spotify-Grenzen, Policy, Latenz, Gerätewechsel, manueller Queue und Resume.
- Schreibe einen Regressionstest, der vor dem Fix fehlschlägt und danach besteht.
- Das True-Shuffle-Run-Ledger bleibt Source of Truth. Provider-Events und Commands müssen idempotent/reconcilierbar sein.

PHASE 3 – ALLE 30 SPOTIFY-USE-CASES
- Die kanonische Langfassung steht in 03A_CANONICAL_USE_CASES.md.
- Implementiere nicht nur No-Repeat, sondern Import/Snapshot, Sync, mehrere Runs, gespeicherte Konfigurationen, kontrollierte Repeats, Favoriten, Mindestabstand, Skip-Policies, Ausschlüsse, Fortschritt, Historie, Reset/Delete, Config-Duplikation/-Übertragung, neue Tracks im laufenden Run und alle drei Policies für manuelle Spotify-Nutzung.
- Löse die offenen Produktfragen aus 09_RISKS_AND_OPEN_QUESTIONS.md mit begründeten und möglichst reversiblen Entscheidungen.
- Erstelle sichere DB-Migrationen und Rollback-Hinweise.
- Nutze Unit-, Property-, Integrations-, Concurrency-, Browser- und Live-Tests.

PHASE 4 – HARDENING UND ABNAHME
- Arbeite die vollständige 08_ACCEPTANCE_TEST_MATRIX.md ab.
- Live-Verhalten muss mit dediziertem Spotify-Premium-Testkonto und realem Gerät geprüft werden.
- Wenn Credentials oder ein Gerät fehlen, implementiere und teste alles andere weiter, markiere den Live-Gate aber ehrlich BLOCKED und liefere eine exakte, redigierte Testanleitung. Behaupte niemals Live-PASS aufgrund von Fakes.
- Prüfe OAuth/Token-Sicherheit, Disconnect/Datenlöschung, Logs, Retries/429/5xx, Restart, Locking und große Playlists.
- Prüfe die Spotify Policy und behaupte keine kommerzielle Zulässigkeit ohne geeignete Prüfung.

PHASE 5 – OPTIONAL WEITERE PROVIDER
- Erst wenn UX und Spotify vollständig PASS sind.
- Prüfe dann Apple Music, YouTube Music und andere vorhandene Provider über eine Capability Matrix.
- Baue nur Funktionen aus, die sich live und policykonform belegen lassen. Nutze ehrliche Utility-/Degraded-Modes, wenn Controller-Parität nicht möglich ist.
- Zusätzliche Provider dürfen Spotify nicht destabilisieren.

Arbeitsregeln:
- Arbeite autonom weiter, solange kein echter externer Blocker vorliegt.
- Keine kosmetischen Schnellfixes anstelle der UX-Neukonzeption.
- Keine ungeprüfte Queue-Strategie.
- Keine Secrets, Tokens oder unnötigen personenbezogenen Daten in Code, Commits, Screenshots oder Logs.
- Keine fremden Änderungen überschreiben.
- Kleine, thematische Commits; bestehende Tests nur mit dokumentierter fachlicher Begründung ändern.
- Keine Funktion als fertig markieren, wenn ihre Evidenzklasse nicht ausreicht.

Erwartete Abschlussartefakte:
- Implementierungsbranch und Commitübersicht
- UX Source Manifest
- ADRs
- vollständige UC-01–UC-30 Evidence Matrix
- automatisierte Testberichte
- redigierter Spotify-Live-Testbericht
- Browser-/Accessibility-Nachweise
- Migrations- und Rollback-Hinweise
- Security-/Privacy-/Policy-Status
- Model Ledger
- klare Liste jedes verbleibenden BLOCKED/FAIL

Beginne jetzt mit PHASE 0. Liefere zuerst den verifizierten Re-Audit, Modell-/Agenten-Routingplan und Gate-Plan; arbeite danach ohne unnötige Unterbrechung durch die Phasen.
```
