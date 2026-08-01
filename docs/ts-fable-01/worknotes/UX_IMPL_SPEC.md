# UX-Implementierungsspezifikation „Nachtpult" (G2) — verbindlich

Basis: Konzept dir-b (concept.md + mock.html), ADR-001-Auflagen, Ist-Inventar-Übernahmen. Repo: /home/user/true-shuffle-PoC, Branch claude/true-shuffle-fable5-run-z2eqzb.

## Nicht verhandelbar

1. Jinja2 + Vanilla-CSS + ES-Modules, kein Build-Step, keine externen Requests (Fonts bleiben selbst gehostet oder System-Stack; KEINE CDN-Fonts). Bestehende Fonts (Archivo/SpaceMono) werden NICHT weiterverwendet → System-Sans-Stack laut Konzept.
2. Tokens exakt aus dir-b/concept.md (Night primär + Paper-Light vollständig). Zustandsfarben NUR für Systemzustände A–D; Statistik/Meter nur Ink-Achse + Signal (ADR-Auflage 4).
3. Zustands-Chips: Farbe + Textur (A gefüllt / B Vollrand / C Punktrand / D Strichrand) + Text. Auf Dashboard-Karten UND Player-Zonen. 3px-Kartenrail in Zustandsfarbe.
4. Disabled: nie Opacity auf Primäraktionen; eigener Disabled-Stil (mind. 4.5:1 Text), aria-disabled + fokussierbar + Begründung daneben (ADR-Auflage 2).
5. Playlist-/Titelnamen: vollständiger Umbruch (hyphens:auto + overflow-wrap:anywhere), KEIN line-clamp (ADR-Auflage 3).
6. Builder: <details>-Akkordeons mit Wert-Zusammenfassung im summary; <fieldset>/<legend> + echte Radios für Presets; nicht-blockierende Konfliktbox mit Ein-Klick-Auflösung; alle Policy-Varianten aufgezählt (4 Skip / 3 Manual / 3 Neue Titel) (Auflage 6).
7. role="progressbar" mit aria-valuenow/min/max, Zahlenlabel als Geschwister (Auflage 6).
8. <main id="inhalt" tabindex="-1">-Landmark auf jeder Seite; Skip-Link bleibt (Auflage 7 + Inventar).
9. Vertragsvokabular auf jeder Run-Karte: aktiv/pausiert/gestoppt*/abgeschlossen + Systemzustand getrennt. (*"gestoppt" existiert im Backend noch nicht — Phase 3; bis dahin nur die vorhandenen Status rendern, aber CSS/Wortschatz vorbereitet.)
10. Wiedergabe-Zone zeigt Titelposition (verstrichene/Gesamtzeit aus duration_ms; live-Update wo Daten da sind, sonst statisch aus letzter API-Antwort).
11. Spotify-Attribution: Textzeile „Wiedergabe über Spotify" + Link auf den Titel/die Playlist bei open.spotify.com (kein Logo-Asset in dieser Phase).
12. Meter-Tracks sichtbar (≥3:1 zur Umgebung ODER 1px-Innenrand); „offen"-Segmente dürfen nicht verschwinden.
13. Aurora: statischer CSS-Gradient im Seitenkopf + Akzentrand des aktiv gesteuerten Runs; bei prefers-reduced-motion KEINE Animation (auch sonst: Animation optional, max. dezent); nie hinter Cover-Art.

## Erhaltene Semantik (aus Ist-Inventar, MUSS überleben)

Skip-Link „Zum Inhalt springen"; :focus-visible 2px-Outline (Signal) + offset; sr-only-Muster inkl. input.sr-only-Fokusweitergabe; reduced-motion-Blocklist (Animationen auf none, nicht nur 0.001ms bei Endlos-Spinnern); Theme-Pre-Paint-Inline-Script (localStorage true_shuffle_theme, data-theme-Override schlägt prefers-color-scheme; Toggle benennt Zielzustand); aria-pressed-Auswahlmuster wo Buttons togglen; aria-current=page in Nav; aria-live=polite auf Anzeigen/Zählern; setNote()-Note-Box je Seite; api()-Fehlervertrag + HTTP_TEXT; followJob() SSE→Polling; „Bereit ≠ Läuft" (active heißt nicht spielt); Terminal-Zustände deaktivieren Transport; confirm() vor Destruktivem mit ehrlichem Folgetext; de-DE-Zahlen/relative Zeiten; „—" statt 0 bei unbekannt; drei Playlist-Größenzustände; Fehler ersetzt Skeleton; Import zerstört Liste nicht; Tastatur-Transport (Leer/→/←) mit Formular-Guard + sichtbare <kbd>-Legende; el()-Helper; fremde Läufe 404.

## Neuer Wortschatz (ersetzt Alt-Vokabular überall)

Hörvorgang (Run), Konfiguration (Preset), Wiedergabe (Spotify-Seite), Titel, Fortschritt, Verlauf, Weiterhören (Dashboard-Primäraktion), „True Shuffle steuert"/„Spotify läuft manuell"/„Wartet auf deine Entscheidung"/„Kein aktives Gerät". Nav: Start · Hörvorgänge · Bibliothek · Dienste (+ Konfigurationen). KEIN Fach/Karte/Laufzettel/Trennstreifen/Plattenschrank. Modi-Namen bleiben fachlich: „Live" (True Shuffle steuert Spotify) und „Handoff" (Playlist wird übergeben) mit den ehrlichen Openness-Badges aus dem Inventar.

## Seiten & Routen

| Route | Template | Inhalt (Phase 1) |
|---|---|---|
| / | home.html | Produktversprechen neu getextet (kein crateviz); Was steuert TS / was bleibt Spotify; ehrliche Grenzen (Premium, eigene Playlists); CTA Verbinden/Bibliothek |
| /connect | connect.html | Dienste-Karten im Nachtpult-System; Zustände verbunden/nicht verbunden/nicht eingerichtet/Token abgelaufen; Disconnect mit ehrlichem confirm |
| /library | library.html | Playlist-Bibliothek + Run-Builder (Preset-fieldset: „Ohne Wiederholungen" [funktional] + 4 weitere Presets als deklarierte „Vorschau — kommt mit dem nächsten Ausbau" disabled-mit-Begründung; Regelgruppen-Akkordeons zeigen alle Varianten, nicht-funktionale als Vorschau markiert; Konfliktbox-Demo-Logik clientseitig); Modus Live/Handoff; Import-/Sync-Status-Platzhalter ehrlich („Sync kommt mit dem nächsten Ausbau") |
| /runs | runs.html | Run Dashboard: Karten mit Systemzustand (A aus watcher.watching; B/C/D soweit ableitbar: drifted→B, kein Gerät→D; C erst Phase 3), Vertragsstatus, Fortschritt, „Weiterhören", Export/Import |
| /player/{id} | player.html | Zwei beschriftete Zonen („Wiedergabe · über Spotify" / „Hörvorgang · True Shuffle"); Cover (artwork_url; Fallback-Panel ohne Cover), Titelposition; Transport (56–72px); Takeover-Banner bei drifted (B) mit Fortsetzen/Pausiert-lassen (= bestehende start/pause-API!); Completion-Zustand; Verlauf-Link; Skips/Ausschlüsse-Sektion (skipped-API) |
| /runs/{id}/verlauf | history.html (neu) | Ereignis-/Trackfolge aus /api/runs/{id}/events, chronologisch, Ereignistyp übersetzt, de-DE-Zeiten; Pagination (limit) |
| /konfigurationen | configs.html (neu) | Config Library als ehrliche Vorschau: erklärt Presets, zeigt „Ohne Wiederholungen" als einzige aktive; Duplizieren/Übertragen als angekündigte Funktionen (disabled-mit-Begründung). KEINE Fake-Funktionalität. |

Neue Routen in app/routes_pages.py ergänzen (require_run für verlauf). KEINE Änderungen an app/routes_api.py, app/runs.py, core/* — Phase 1 ist Frontend + Pages.

## Player-Systemzustands-Ableitung (Phase 1, ehrlich)

A „True Shuffle steuert": status=active && watcher.watching && !drifted. B „Spotify läuft manuell": drifted=true (Banner: „Hörvorgang angehalten, Fortschritt bei Titel X gesichert"; Aktionen: „Hörvorgang fortsetzen" = POST start, „Pausiert lassen" = POST pause). C: in Phase 1 nicht erzeugbar → nicht simulieren, aber CSS/Komponente existiert (im Styleguide sichtbar). D „Kein aktives Gerät": Geräteliste leer bei remote-Provider bzw. Start-Fehler → D-Karte mit Handlungsanleitung. „Bereit" (nicht spielend) bleibt eigener neutraler Zustand.

## Styleguide-Seite (nur dev)

/styleguide (Route, nur wenn settings.debug oder ENABLE_DEMO_PROVIDER): rendert alle Komponenten inkl. Zustand C, Leer-/Fehler-/Skeleton-Zuständen, beide Themes — Grundlage der Browser-/A11y-Abnahme für Komponenten, die im Demo-Flow nicht erreichbar sind.

## Bestehende Tests

tests/test_api.py-Renderfixtures (crateviz/divider u. ä.) brechen absichtlich: Ersatz-Assertions auf neue ehrliche Semantik (Seite rendert, main-Landmark, neue Statusworte, aria-Muster). Jede Teständerung mit Begründungskommentar „UI-Erneuerung TS-FABLE-01 (ADR-001): visuelle Fixture ersetzt durch semantisches Äquivalent". Testabdeckung darf sinken für reine Deko-Assertions, NICHT für Zustands-/Ehrlichkeitssemantik. Alle anderen Tests bleiben unverändert grün.

## Definition of Done je WP

ruff clean; pytest komplett grün (inkl. begründeter Fixture-Updates); Seiten rendern bei 320/390/768/1280 ohne horizontalen Overflow; beide Themes; alle interaktiven Ziele ≥44px (Transport ≥56px); Fokus sichtbar; reduced-motion tot; deutsche Texte vollständig (kein TODO/Lorem).