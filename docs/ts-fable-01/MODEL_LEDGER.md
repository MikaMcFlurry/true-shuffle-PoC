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
| 9 | Phase-2-Forensik: Simulator, SP-008-Rotbeweis, Strategie-Bench, Live-Guide | Fable 5 | Commit `a7b060a`; 367 passed + 2 strict-xfail | Adversarial-Workflow (#10) |
| 10 | Adversariale Verifikation des Forensik-Pakets (3 Linsen) | Workflow, 3× **Opus** effort=high | Kernbeweis bestätigt (echter Watcher-Pfad unabhängig reproduziert); Messmethodik als FLAWED entlarvt (Lücken-/429-Metrik, S3-Idempotenz hohl, S3 im Deck-Titel-Queue-Fall schlechtester Kandidat) — kippte das Ranking | Lead — Reparaturauftrag + ADR-002 |
| 11 | Forensik-Reparatur (12 Punkte, Szenarien g/h, Silence-/Quota-Metrik, AN-5/6/7) | Fable 5 (nach Session-Limit-Abbruch fortgesetzt) | Commit `0ccb413`; 408 passed + 2 strict-xfail | Lead (Pins + Suite) |
| 12 | ADR-002 Strategieentscheidung | **Lead (Fable 5)** auf verifizierter Messlage | Commit `fd2a3ce`: uris-Fenster Default; S3 verworfen (irreversible Queue), S4 Option, S2 Notmodus, SDK qualitativ abgelehnt | adversariale Evidenz #10 |
| 13* | WP3-A Schema v3 + Migrations-Runner; ADR-003 | Fable 5 (Lead) auf Opus-Blueprint (#3) | `70d7b81`, `2b74e2e` | Lead + spätere Property-Suite (#16) |
| 14* | WP3-C Selection-Engine nach Vertrag | Agentenlauf (Session-Modell) | `7452790`, 57 Tests | Lead + unabhängige Property-Suite (#16) |
| 15* | WP3-D1–D4 Import/Snapshot, Run-Lifecycle v3, Policies/Ledger/F8, Frontend-Verdrahtung | Agentenläufe (Session-Modell, je WP getrennt; 2 Limit-Abbrüche überstanden) | `9b10db8`, `fa19bc4`, `2ad8069`, `0314439` | Lead-Diff-Review je WP; Browser-Suite (Opus-Artefakt) 50/50 |
| 16* | WP3-E1 unabhängige Property-Tests | **Opus** (kein Implementierungskontext) | `1a8de05`: 9 Verletzungen gefunden; Fix-Lauf `55550f3` (getrennt), 13 strict-xfails → Passes | Lead |
| 17* | WP3-E2 Evidence-Matrix + adversariale Verifikation | Bau: Session-Modell; Verifikation: 3 getrennte Linsen (**Opus**, effort=high) | `52910af`/`1abd4fe`: 13 Widerlegungen eingearbeitet, Statuskorrekturen UC-24/RUN-02/RUN-03 | Lead |

\* Einträge 13–17 nachgetragen am 2026-08-01 durch die Fortsetzungssession (rekonstruiert aus RUN_STATE.md, GATE_STATUS.md und Commit-Historie — die Vorsession hatte das Protokoll ab WP3 nicht fortgeschrieben).

### Fortsetzungssession (2026-08-01, Branch `claude/true-shuffle-fable5-lead-928f25`)

| # | Arbeitspaket | Modell/Effort | Ergebnis | Reviewer |
|---|---|---|---|---|
| 18 | Session-Re-Audit: Baseline-Reproduktion (614+50+8 grün, Ruff clean) + Doku-Freshness-Check Spotify (Changelog/Policy/Player-Referenz/Migrationsguide, Stand 01.08. unverändert) | Lead (Fable 5); Freshness: Haiku-Agent, effort low | Baseline exakt reproduziert; Phase-0-Befunde weiter gültig | Lead |
| 19 | §A1 Fenster-Re-Assert (ADR-004): rot-zuerst-Suite `test_window_reassert.py`, Hybrid-Fix (Anker-Invalidierung + nahtloser Sofort-Re-Assert + Watcher-Selbstheilung) | Lead (Fable 5) | `c86ed42`; 5 Tests rot→grün, 619 grün | vorgesehen: adversarialer Opus-Review des §A-Deltas (#22) |
| 20 | §A2/A5/A6-Backend: UC-24-Reopen, UC-07-Gewichts-API, UC-22-Zählsemantik (Vorgänge), Deck-Listing-Route | Lead (Fable 5) | `b856d0e`, `a97987c`; test_completion_flows rot→grün, 622 grün | Opus-Testagent (#21, unabhängige Assertions) + Review #22 |
| 21 | §A2/A8/A9 unabhängige Tests (Progress-Stats, Restart-E2E, apply-sync HTTP) | **Opus** (kein Implementierungskontext) | ✅ `e3cd78b`: 17 Tests grün, 4 Befunde (u. a. Cookie-gebundene Identität) | Lead-Review (Muster-Sweep, eigener Lauf) |
| 22 | §A3/A4/A5-UI/A7 Frontend (Reaktivieren-Ansicht, favorite_weight im Builder, Pro-Titel-Gewicht, requeue_later-Text) + Browser-Tests | Sonnet | ✅ `7ae2520`: 4 neue Browser-Tests; Browser-Vollsuite 54/54 im Lead-Abnahmelauf | Lead-Diff-Review + eigener Suite-Lauf; adversarialer Review #24 |
| 23 | Phase 4 §B1/B2: ERR-01…08/MAN-01…05-Matrix (36 Tests, 2 ehrliche strict-xfails) | **Opus** (kein Implementierungskontext) | ✅ `7ee535a`; 8 Befunde, davon 4 vom Lead gefixt (`67e4009`: Geräteklasse, reaktives playback_failed, Positionstreue, Gerätefolge) — xfails regulär geflippt | Lead (Fix-Pass + dokumentierte Teständerungen) |
| 24 | Adversarialer Review der §A-Abschlussrunde (6 Linsen) | **Opus** (kein Implementierungskontext) | ✅ Rot-vor-Fix + Suitenzahlen exakt bestätigt; **1 kritischer Fund** (Fast-Path-Gap-Bug B1) + 10 Mittel/Gering-Funde; alle am selben Tag gefixt (`5b7ae8a`, `0610b67`, `8ae8741`) | Lead — Fixes + Matrix-Korrekturen |
| 25 | Unabhängiger Security-/Privacy-Review (OAuth/PKCE, TokenVault, CSRF, IDOR, F10, Logs) | **Opus** (kein Implementierungskontext) | ✅ 20 Findings + 18 solide bestätigt; 5 blockierende Auflagen behoben+getestet (`07d5575`), Rest dokumentiert | Lead — Fixes + `SECURITY_PRIVACY_STATUS.md` |
| 27 | Phase-4-Fix-Pass: 4 ERR/MAN-Funde (`67e4009`), 5 Security-Auflagen (`07d5575`), B1-Gap-Guard (`5b7ae8a`) | Fable 5 (Lead) auf fremden Review-Funden | ✅ 704 grün, Ruff clean | Reviews #23/#24/#25 = Erzeuger der Funde (Erzeuger≠Abnehmer gewahrt) |
| 28 | Unabhängiger Release-Gesamt-Review (G5-Entscheidung, 6 Linsen) | **Opus** (kein Implementierungskontext, keine Bindung an frühere Reviews) | ✅ **G5-Verdikt PASS(automated) mit Auflagen**, 0 Blocker; Suiten/Migrationen/Secrets/Live-Ehrlichkeit selbst reproduziert (704/8/54/13 grün); 2 Doku-Auflagen (AUF-1 Browsermatrix, AUF-2 Kopfzahl) | Lead — Auflagen eingearbeitet, G5-Stempel gesetzt |
| 26 | Phase 4 §B4/B5 (Lead): 10k-Perf-Profil + Replan-Fastpath, Concurrency-Suite + Lock-Leak-Fix, F10-Löschpfad, Policy-Status | Fable 5 (Lead) | ✅ `16a12b1`, `71b2aa9`, `6d45dee` | unabhängige Reviews #24/#25 decken die Artefakte mit ab |
