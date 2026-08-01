# Phase-1-Implementierungszuschnitt (nach Konzeptauswahl)

Regel aus 04: Funktionslogik darf für UX simuliert werden; der Spotify-Fix verdrängt die UX-Phase nicht.
Sequenz: Auswahl-ADR + öffentliches Source Manifest → Implementierung → Browser-/A11y-Abnahme → G1/G2-Gate.

## Arbeitspakete (nach Auswahl)

| WP | Inhalt | Modell | Abnahme |
|---|---|---|---|
| UX-IMPL-0 | tokens.css + neues base.html-Gerüst (Nav, Statuszonen-Grammatik, Chips, Buttons, Notes, Fokus/Reduced-Motion/Theme-Mechanik aus Inventar übernehmen) | Sonnet | Lead-Diff + Browser-QA |
| UX-IMPL-1 | Screens Connect + Library (bestehende API; Import-/Sync-Status als UI-Zustand, Sync simuliert mit „Vorschau"-Kennzeichnung) | Sonnet | Browser-QA (Opus) |
| UX-IMPL-2 | Run Dashboard + Run Builder (Dashboard: bestehende /api/runs; Builder: Preset-UI vollständig, Start nutzt bestehenden No-Repeat-Pfad, andere Regeln als deklarierte Vorschau bis Phase 3) | Sonnet | Browser-QA |
| UX-IMPL-3 | Player + Manual Takeover + Completion (bestehende Player-API; Zustände A-D aus watcher/drift ableitbar; C/D simulierbar über Demo-Provider) | Sonnet | Browser-QA |
| UX-IMPL-4 | Progress + History + Config Library (History: /api/runs/{id}/events existiert; Config Library als UI mit Vorschau-Daten bis Phase 3) | Sonnet | Browser-QA |
| UX-QA | Playwright-Suite: Screenshot-Matrix (390/768/1280 × dark/light), Keyboard-Walk, Fokus sichtbar, reduced-motion, Touch-Ziele, kein horizontaler Overflow, axe-core-Scan; Demo-Provider als Backend | Opus (unabhängig) | Lead |

## Verbindliche Übernahmen aus dem Ist-Inventar (semantics_to_keep)

Skip-Link, :focus-visible-Outline, sr-only-Muster, reduced-motion-Blocklist, Theme-Pre-Paint-Script + data-theme-Override, aria-pressed-Auswahlmuster, aria-live auf Anzeigen, setNote()-Muster, api()-Fehlervertrag, followJob() SSE→Polling, „Bereit ≠ Läuft", Terminal-Zustände deaktivieren Transport, confirm() vor Destruktivem, de-DE-Formatierung, ehrliche Lücken („—" statt 0), Ownership-404.

## Neuer Wortschatz (ersetzt Fach/Karte/Laufzettel)

Hörvorgang, Konfiguration, Wiedergabe (Spotify), Titel, Fortschritt, Verlauf. Statusworte: aktiv/pausiert/gestoppt/abgeschlossen. Zustandssprache A–D aus gewähltem Konzept.

## Browser-Testinfrastruktur (neu)

tests/browser/ mit Playwright (python), Chromium executable_path=/opt/pw-browsers/chromium, App via uvicorn+ENABLE_DEMO_PROVIDER=true, eigene Test-DB im Scratch. Läuft NICHT im normalen pytest-Lauf (Marker browser), eigene CI-Notiz. axe-core als Inline-JS-Injektion (self-contained, kein CDN — Datei einchecken unter tests/browser/vendor/axe.min.js? → Lizenz MPL2, ok, aber Repo-Gewicht ~500KB; Alternative: eigene Grundchecks (Kontrast via computed styles, Fokus-Reihenfolge, aria-Anwesenheit) + axe optional wenn Datei vorhanden. Entscheidung beim QA-WP.)
