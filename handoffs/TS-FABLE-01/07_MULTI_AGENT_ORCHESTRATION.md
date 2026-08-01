# Multi-Agent-Orchestrierung

## Rolle des Leads

Fable ist Integrator, Entscheider und Qualitätsverantwortlicher. Subagenten liefern begrenzte, überprüfbare Arbeitspakete; sie entscheiden nicht eigenmächtig über Gesamtarchitektur, Merge oder Release.

## Modell-Routing

Zu Beginn:

1. alle tatsächlich verfügbaren Modelle und Agentenfähigkeiten erfassen,
2. eine Routing-Tabelle erstellen,
3. für jedes Arbeitspaket das beste verfügbare Modell wählen,
4. Fallback dokumentieren,
5. Ergebnis durch ein anderes Modell oder einen unabhängigen Lauf prüfen.

Beispielhafte Zuordnung, nur wenn verfügbar:

| Arbeit | Bevorzugtes Profil |
|---|---|
| Gesamtarchitektur, schwierige Trade-offs, Policy | stärkstes Reasoning-/Opus-Profil |
| UX-Konzept und Mika-Transfer | stärkstes Design-/Fable-Profil |
| große, klar spezifizierte Implementierung | schnelles, starkes Sonnet-/Coding-Profil |
| Spotify-Live-Forensik | starkes Tool-/API-/Concurrency-Profil |
| Zustandsmodell und Property Tests | formales Reasoning-/Test-Profil |
| unabhängige UX-Abnahme | anderes Modell als der UX-Erzeuger |
| Security/Privacy/Release Review | unabhängiges starkes Review-Profil |

Nicht jedes Modell muss künstlich verwendet werden. Aus allen verfügbaren Modellen soll jeweils das am besten passende ausgewählt werden. Tatsächliche Nutzung und Begründung kommen in einen Model Ledger.

## Empfohlene Agentenrollen

- Repository-/Migration-Auditor
- UX Researcher und Mika-Retriever
- UX System Designer
- UX Implementer
- unabhängiger UX-/Accessibility-Reviewer
- Spotify Live Investigator
- Provider-/Concurrency-Architect
- Domain-/Data-Model-Engineer
- Backend-/Frontend-Implementer
- Property-/Integration-Test-Engineer
- Browser-/E2E-QA
- Security-/Privacy-/Policy-Reviewer

Rollen dürfen kombiniert werden, wenn Unabhängigkeit der Abnahme erhalten bleibt.

## Übergabevertrag an jeden Subagenten

Jeder Auftrag enthält:

- exakten Basis-Commit,
- enge Dateigrenzen oder klares Subsystem,
- relevante Use-Case-IDs,
- verbindliche Invarianten,
- erwartete Artefakte,
- erforderliche Tests,
- verbotene Annahmen,
- Evidenzklasse,
- Rückgabeformat: Befund, Änderungen, Tests, Risiken, offene Entscheidungen.

Ein Subagent soll keine parallelen User-Änderungen überschreiben und keine fremden Worktrees/Branches „aufräumen“.

## Phasen und Gates

### G0 – Re-Audit

- Basis-Commit bestätigen,
- Handoff vollständig lesen,
- aktuelle APIs/Policies/Library-Revisionen prüfen,
- Plan, Routing und Risikoänderungen festhalten.

### G1 – UX-Konzept

- drei Single-Source-Konzepte,
- Source Manifest,
- kritische Flows,
- unabhängige Auswahlprüfung.

### G2 – UX-Implementierung

- vollständiges Pflicht-Screen-Set,
- Responsive/Accessibility,
- Browserbelege,
- keine kritischen Review-Funde.

### G3 – Spotify-Forensik und Strategieentscheidung

- realen Fehler reproduzieren,
- mindestens zwei Strategien bewerten,
- ADR,
- Queue-Duplikat-Test vor Fix rot und nach Fix grün.

### G4 – Spotify-Produktumfang

- Domänenmodell erweitern,
- Use Cases 1–30 implementieren,
- Datenmigrationen,
- automatisierte und Live-Abnahme.

### G5 – Hardening

- Concurrency, Retries, Restart, Security, Privacy, Performance,
- vollständige Evidence Matrix,
- unabhängiger Release Review.

### G6 – Optionale Provider

Nur nach PASS der vorherigen Gates.

## Parallelisierung

Parallel erlaubt:

- UX-Quellenrecherche und aktueller API-/Policy-Check,
- Domänenmodell-Review und Live-Instrumentierungsplan,
- Testmatrix und Migrationsanalyse.

Nicht parallel ohne Integrationspunkt:

- konkurrierende Datenbankschemata,
- mehrere Agenten an denselben Core-Dateien,
- Spotify-Strategieimplementation vor der ADR,
- Provider-Ausbau vor Spotify-PASS.

## Integrationsregeln

- kleine, thematische Commits,
- Migrationspfade und Downgrade/Rollback dokumentieren,
- keine Änderung nur deshalb akzeptieren, weil der Implementer eigene Tests geschrieben hat,
- unabhängiger Reviewer prüft Diffs und Evidenz,
- bei Konflikten entscheidet der Lead anhand Use Cases und Invarianten,
- bestehende Tests dürfen nur mit dokumentierter fachlicher Begründung geändert oder entfernt werden.

## Abschlussbericht

Enthält:

- Branch und Commitfolge,
- Gate-Status,
- Use-Case-Matrix,
- Model Ledger,
- ADR-Liste,
- Test- und Live-Evidenz,
- bekannte Einschränkungen,
- Policy-/Security-Status,
- nicht ausgeführte optionale Providerarbeit,
- genaue nächste Schritte für jedes `BLOCKED`.

