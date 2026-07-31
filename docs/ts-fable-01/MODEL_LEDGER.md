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
