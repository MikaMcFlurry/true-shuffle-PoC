# Implementation continuation

This mandate has been implemented locally on `codex/implement-cloudflare-restart`. Read `docs/ai-dev/EVIDENCE.json` and `PROJECT_CONTEXT.md` for current results and exact remaining live/deployment gates. The original task below remains historical authority for requirements. The user explicitly authorized deployment in this execution; absent Cloudflare authentication and live provider access prevent it, rather than missing approval.

# Start the Cloudflare implementation

Select `MikaMcFlurry/true-shuffle-PoC` and branch `codex/cloudflare-restart-plan` in Codex. No merge is required to start. This branch is a full restart/handoff, not a testable redesigned application.

Copy this prompt into a new Codex chat:

```text
Implementiere den True-Shuffle-Neustart auf diesem Branch vollständig. Nutze die enthaltenen Mika-Skills: Dev Studio als Orchestrator, Repo Intelligence für die frische Baseline, Product Director, Engineering, Verification, Red Team und Repo Handoff passend zur Phase. Nutze den projektlokalen Impeccable-Skill für ein unabhängiges ruhiges Musikplayer-Design. Prüfe sein Online-Update mit funktionierendem Netzwerk; das vorhandene Bundle ist 4.1.2, der bisherige Updateversuch war erfolglos.

Lies zuerst AGENTS.md, docs/ai-dev/HANDOFF_MAP.json, REPOSITORY_INTELLIGENCE.md/.json, MISSION.md, PROJECT_CONTEXT.md, EXECUTION_PLAN.md und EVIDENCE.json unter docs/ai-dev. Prüfe Branch-/Deployment-Frische und halte die Nachweise synchron. Der tatsächliche Anwendungscode ist Cloudflare/Preact/Hono/Durable Objects vom claude/true-shuffle-spotify-95zw0m-Stand c9bd08246487df1edcb5d19d39ec96c93f04fb9d. main und PR #7 sind der falsche Python/Fly-Vorgänger. Die Website ist https://true-shuffle.mikahertler-72c.workers.dev/; passende Frontend-Assets beweisen noch nicht den Worker-Commit.

Setze die geschützten Anforderungen NN-01 bis NN-11 um: dauerhafte unendliche Warteschlange, derselbe Lauf beim normalen Play, unvollendeter Song an der zuletzt beobachteten Position oder derselbe Song von vorne; Fortsetzung nach Auto-Stopp, Spotify-Play, App-Schließung und Geräte-/Browserwechsel. Erhalte den großen Verlauf und alle guten Entdeckungs-/Mix-/Regel-/Favoriten-/Ban-/Import-Funktionen. Behebe die belegten Queue-/Checkpoint-Konflikte und prüfe das tatsächliche Spotify-Limit mit bereinigten Nutzungsdaten. Respektiere Retry-After und dauerhafte Cooldowns in allen Pfaden, ohne Client-ID-Wechsel oder erfundene Reset-Zeit. Integriere MA Spotify Connect und eine getrennte fähigkeitsbasierte native HA/MA-Route; behaupte keine generische Gerätefunktion ohne reale Unterstützung.

Arbeite den EXECUTION_PLAN in integrierten vertikalen Schritten ab; erweitere die realistische Spotify-Testumgebung und stelle die Browserprüfung wieder her. Gestalte und implementiere die echten Preact-Oberflächen einschließlich Fehler-/Offline-/Pausen-/Gerätezuständen. Aktualisiere Design- und Produktwahrheit für tatsächlich gebaute Änderungen. Prüfe Build, Typen, Lint, Unit-, Worker-, Browser-, Migrations- und Recovery-Verhalten sowie die gesamte Akzeptanzgeschichte. Keine weitere Planung als Endergebnis. Wenn Live-Zugang fehlt, erledige alle unabhängigen Änderungen und nenne die genaue verbleibende Prüfung. Unterscheide Simulation, echte Live-Nachweise und Blocker. Hole für eine materielle Freigabe eine frische unabhängige Prüfung gemäß Mika Red Team.

Erhalte Durable-Object-Identität, Klassen, Bindings, Migrationen, APP_SECRET und Nutzerdaten. Isoliere Preview-Storage vor Testschreibzugriffen. Kein Produktionsmerge oder Deployment ohne ausdrücklichen Release-Auftrag. Liefere einen überprüfbaren Implementierungs-PR mit nachvollziehbaren Tests und verbleibenden Risiken.
```

Use this existing branch as the starting point; create an implementation branch if repository policy requires it. The preparation allowlist in HANDOFF_MAP applies to construction of this handoff, not a prohibition on the explicitly authorized downstream application changes. Rebind/refresh the map and execution contract before implementation writes.
