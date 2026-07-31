# Model Ledger — TS-FABLE-01

Stand: 2026-07-31 (wird pro Arbeitspaket fortgeschrieben)

## Tatsächlich verfügbare Modelle und Agentenfähigkeiten (enumeriert, nicht erfunden)

**Lead-/Session-Modell:** Fable 5 (Mythos-Klasse, stärkstes verfügbares Reasoning-Profil). Der Lead bleibt Integrator und prüft jede Übergabe.

**Für Subagenten adressierbare Modellstufen** (Agent-/Workflow-Override): `fable` (Fable 5), `opus` (Opus — aktuelle Generation Opus 5), `sonnet` (Sonnet — aktuelle Generation Sonnet 5), `haiku` (Haiku 4.5). Zusätzlich je Agent einstellbare Reasoning-Effort-Stufen (low…max).

**Nicht verfügbar / Fallbacks:** Eine separat adressierbare Stufe „Opus 4.8" existiert in dieser Umgebung nicht — der `opus`-Alias löst auf die aktuelle Opus-Generation auf; dokumentierter Fallback: `opus` wird überall dort eingesetzt, wo der Auftrag ein Opus-Profil nennt. Modelle anderer Anbieter sind nicht angebunden. Es wird keine Verfügbarkeit erfunden.

**Agentenfähigkeiten:** parallele Subagenten (general-purpose mit vollem Toolzugriff, Explore read-only, Plan), deterministische Multi-Agent-Workflows (Fan-out/Pipeline, strukturierte Rückgaben, unabhängige Verifikationsläufe), Browserautomation (Chromium/Playwright vorinstalliert), Live-Web-Zugriff für Doku-Verifikation.

## Routing-Tabelle (Arbeit → Modell, mit Begründung)

| Arbeitspaket | Modell | Begründung | Unabhängige Abnahme durch |
|---|---|---|---|
| Gesamtarchitektur, ADRs, Policy-Bewertung, Integration | Fable 5 (Lead) | stärkstes Reasoning; Integrator-Rolle laut Handoff | Opus-Review-Agent (separater Lauf) |
| UX-Konzepte aus Mika-Library (3× Single-Source) | Fable 5 (getrennte Agentenläufe je Konzept) | stärkstes Design-/Transfer-Profil; Konzepte müssen unabhängig voneinander entstehen | Opus (Fidelity/Usability/A11y-Review — anderes Modell als Erzeuger) |
| UX-Implementierung (Templates/CSS/JS, klar spezifiziert) | Sonnet | schnelles, starkes Coding-Profil bei engem Scope | Fable 5 (Lead-Diff-Review) + Browser-QA-Agent (Opus) |
| Spotify-Live-Forensik, Instrumentierung, Concurrency | Fable 5 | Tool-/API-/Nebenläufigkeits-Profil, höchste Fehlerkosten | Opus (Strategie-/ADR-Gegenprüfung) |
| Domänenmodell, Migrationen, Regel-Engine | Fable 5 | fachlicher Kern, höchste Korrektheitsanforderung | Opus (Property-Test-Erzeuger prüft Implementierung eines anderen Laufs) |
| Property-/Zustandsmodell-Tests | Opus | formales Reasoning-Profil; Erzeuger ≠ Implementierer | Fable 5 (Lead) |
| Mechanische Sweeps (Doku-Fetch, Inventuren, Format) | Haiku bzw. low-effort-Agenten | ausreichend; schont Budget für kritische Pfade | Lead-Stichprobe |
| Security-/Privacy-/Release-Review | Opus (unabhängiger Lauf, kein Implementierungskontext) | unabhängiges starkes Review-Profil | Lead entscheidet über Findings |

Regeln: Erzeuger und Abnehmer kritischer Arbeit sind nie derselbe Agentenlauf. Kein Modellaufruf zur Quotenerfüllung. Jede tatsächliche Nutzung wird unten protokolliert.

## Protokoll der tatsächlichen Nutzung

| # | Arbeitspaket | Modell/Effort | Ergebnis | Reviewer |
|---|---|---|---|---|
| 1 | BASE-05: 4 parallele Doc-Audits (Player-Referenzen, Feb-2026-Guide, Juli-2026-Changelog, Policy/Terms) | Workflow, 4 Agenten, Session-Modell, effort=low | strukturierte, datierte Quellbefunde; siehe PHASE0_REAUDIT.md | Lead (Fable 5) — plausibilisiert gegen Handoff-Angaben, keine Widersprüche |
| 2 | Library-Retrieval: 7 Kategorie-Volltextleser (123/123 Einträge) + Ist-Inventar der Alt-UI | Workflow, 8 Agenten, Fable 5 | Kategorie-Shortlists mit F1–F8-Scores; vollständiges UI-/Semantik-/Test-Inventar | Lead — Finalisten selbst vollständig gegengelesen |
| 3 | Domänenmodell-/Migrationsanalyse (Phase-3-Vorarbeit) | Plan-Agent, **Opus** | v3-Zielschema (4 Schichten), 10-Schritte-Migrationspfad, Vorschläge zu den 10 offenen Produktfragen | Lead — Entscheidung in Phase 3 als ADRs |
| 4 | 3 unabhängige Single-Source-UX-Konzepte (Leitstand/Nachtpult/Cobalt-Kabinett) | Workflow, 3 getrennte Agenten, Fable 5 | Konzeptdokumente + responsive HTML-Mocks mit berechneten Kontrasten | unabhängiger Opus-Review (#5) |
| 5 | Unabhängiger Fidelity-/Usability-/A11y-Review der 3 Konzepte | **Opus** (kein Erzeugungskontext) | Alle Kontrastwerte nachgerechnet (keiner geschönt), Browser-Audit, CVD-Simulation; Ranking B>A>C mit kritischen Funden | Lead — Entscheidung ADR-001 inkl. verbindlicher Auflagen |
| 6 | UX-Implementierung Teil 1+2 (Foundation, alle Seiten) | Sonnet (2 sequenzielle Läufe; Teil 2 nach Session-Limit-Abbruch fortgesetzt) | Commits `50703cf`, `6eeb9b4`+`b8013c6`; 308 Tests grün | Lead-Diff-Review + unabhängige Browser-QA (#7) |
| 7 | Browser-/A11y-Abnahme + dauerhafte Playwright-Suite | **Opus** (kein Implementierungskontext) | 46-Test-Suite als Repo-Artefakt (`90692bb`); Verdikt „noch nicht PASS" mit 3 Blockern + Kleinfunden | Lead — Fix-Pass beauftragt |
| 8 | G2-Fix-Pass (11 Funde) | Sonnet | Commit `4f8e386`; Abnahme durch die UNVERÄNDERTE Opus-Suite: 46/46 grün (Agent lieferte keinen Endbericht — Evidenz ist der Suite-Lauf, vom Lead selbst ausgeführt) | Opus-Suite + Lead |
