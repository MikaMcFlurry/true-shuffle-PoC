# UX-Flow-Vertrag TS-FABLE-01 (konzeptunabhängig, verbindlich für alle drei Konzepte)

Produkt: True Shuffle — persistenter, regelbasierter Hörstand über Spotify (später weitere Provider).
Sprache: Deutsch (natürlich, keine Anglizismen-Kaskaden). Mobile-first, Desktop gleichwertig.

## Fachbegriffe (verbindlich, deutsch)

- **Hörvorgang** (= Run): gespeicherter Fortschritt + Regeln für eine Playlist. Mehrere je Playlist möglich.
- **Konfiguration** (= Preset): benanntes, wiederverwendbares Regelwerk (z. B. „Ohne Wiederholungen", „Lange Autofahrt").
- **Wiedergabe**: was Spotify gerade tut. Nie mit dem Hörvorgang gleichsetzen.
- Statusbegriffe: aktiv · pausiert · gestoppt · abgeschlossen. („Stoppen" behält Fortschritt; „Löschen" ist destruktiv mit Bestätigung.)

## Pflicht-Screens (aus 04, mit Kernaussage)

1. **Connect/Einstieg**: Was True Shuffle steuert, was Spotify bleibt; Berechtigungen; ehrliche Grenzen (Premium für Live-Steuerung, nur eigene/kollaborative Playlists lesbar). Zustände: nicht verbunden / verbindet / verbunden / Token abgelaufen / Fehler.
2. **Library**: eigene Playlists, Import-/Sync-Status je Playlist (nie importiert / importiert am … / Änderungen verfügbar / synchronisiert). Pagination für viele Playlists.
3. **Run Dashboard**: mehrere unabhängige Hörvorgänge, auch derselben Playlist; je Karte: Playlist, Konfigurationsname, Fortschritt, Status, zuletzt gehört, „Weiterhören"-Primäraktion.
4. **Run Builder**: Preset zuerst (max. 5 benannte Presets sichtbar), progressive Offenlegung: Wiederholungsregeln (No-Repeat / Mindestabstand / Quote+Gewichtung), Favoriten, Skip-Policy (4 Varianten), Manual-Use-Policy (3 Varianten), Neue-Titel-Politik (3 Varianten). Regelkonflikt-Erklärung vor Start.
5. **Player/Run-Control-Center**: aktueller Titel MIT Cover + Artist (Spotify-Policy II.5), Attribution zu Spotify, Run-Status-Zone getrennt von Wiedergabe-Zone, nächste regelkonforme Aktion, Gerätezustand, große Transport-Touchziele.
6. **Manual Takeover**: sichtbarer Zustand „Spotify manuell übernommen" + Entscheidung (fortsetzen/pausiert lassen) je nach Policy „nachfragen"; nie modal-blockierend während Fahrt — als persistenter, klar erkennbarer Zustandsbanner.
7. **Progress**: gespielt/offen/übersprungen/ausgeschlossen/Wiederholungen/%; verständlich bei 1500+ Titeln.
8. **History**: chronologische Ereignis-/Trackfolge mit Ereignistyp (gespielt, übersprungen, manuell, Sync, Drift) und Zeit.
9. **Config Library**: Konfigurationen speichern, bearbeiten, duplizieren, auf andere Playlist anwenden (mit Erklärung, was mit trackbezogenen Regeln geschieht).
10. **Completion**: Abschluss würdigen; Optionen: neuer Durchlauf, Reset, Regeln ändern, beenden.

## Vier Systemzustände — immer visuell trennbar (F3)

A) True Shuffle steuert · B) Spotify manuell übernommen · C) wartet auf Entscheidung · D) kein aktives Gerät / Verbindungsproblem.
Jeder Zustand: eigene, nicht nur farbliche Kodierung (Farbe + Form/Ikon + Text), sichtbar auf Player UND Dashboard.

## Pflicht-Randzustände

leer (keine Playlists, kein Run, leere Historie), ladend (Skeleton), offline/degraded, auth-abgelaufen, Fehler mit nächster Aktion, lange Namen (Titel > 60 Zeichen, deutsche Komposita), fehlende Cover, 10.000-Track-Playlist.

## Technische Leitplanken

Jinja2 + Vanilla-CSS (Custom Properties, keine Frameworks) + ES-Modules, kein Build-Step. Dark + Light. prefers-reduced-motion respektieren. Touch-Ziele ≥ 44px. Fokus sichtbar. Kontrast AA. Kein horizontaler Overflow. Kein WebGL/Canvas als Pflicht.

## Erhaltene funktionale Semantik (aus Ist-Inventar zu übernehmen, visuell frei)

Wird nach Inventar-Rückgabe ergänzt: bestehende ARIA-Muster, Keyboard-Transport, SSE-Job-Fortschritt, Drift-Events, Skeleton-Zustände.
