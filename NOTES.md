# Notizen: Stand von true-shuffle

Stand 2026-10-04, Branch `claude/true-shuffle-spotify-95zw0m`.

## Ziel

true-shuffle macht aus Spotify-Playlists „Sender mit Gedächtnis“. Es läuft als Cloudflare Worker im kostenlosen Plan, für bis zu 5 Konten, nur mit Spotify Premium.

Was es leisten soll, nach Rang:

1. Kein Fortschritt geht verloren: Jeder Song, der irgendwo mindestens 30 s lief, zählt als gehört.
2. Keine schnellen Wiederholungen innerhalb von 24 h.
3. Jeder Song kommt irgendwann dran, lange nicht gehörte zuerst.
4. Favoriten kommen öfter, mit einer Woche Pause.
5. Neue Musik etwa im Verhältnis 60/10/30 (ungehört/Favoriten/Neuentdeckungen).

Feste Regeln:

- Früher Skip unter 30 s heißt „nicht jetzt, seltener“.
- Daumen runter heißt „nie wieder“.
- Der Gastmodus endet nach 6 h, und was der Gast hört, bleibt aus dem Gedächtnis.
- true-shuffle greift nicht in die normale Spotify-Nutzung ein.
- Die Oberfläche sagt ehrlich, was sie weiß, lieber eine Lücke als eine erfundene Angabe.

Die Oberfläche ist ein 50er-Röhrenradio: Die Sender stehen auf der Glasskala, „true-shuffle“ als Messingemblem auf dem Stoff. Die Designvorgabe liegt in `.impeccable/surfaces/src-client.md`, das Designsystem in `DESIGN.md`.

## Stand

- Unit-Tests 280/280, Browser-Tests 12/12, Typprüfung und Biome über die eingecheckten Dateien grün.
- Das Design hat die unabhängige Finish-Prüfung nach Revision 3 bestanden (Emblem, Radioform).
- Die letzte unabhängige Fehler- und Sicherheitsprüfung (RT28) ergab: bereit, mit nicht blockierenden Befunden.

## Offene Schritte

Für den Besitzer (Anleitung in `docs/SETUP.md`):

1. Worker in Cloudflare mit Workers Builds anlegen.
2. Variablen und Secrets setzen:
   - `SPOTIFY_CLIENT_ID`
   - `APP_SECRET`
   - optional `ALLOWED_SPOTIFY_IDS`, `LASTFM_API_KEY` und `ANTHROPIC_API_KEY`
3. In der Spotify-App die Redirect-URI `https://true-shuffle.<subdomain>.workers.dev/auth/callback` eintragen.
4. In der User Management der Spotify-App alle Konten eintragen (höchstens 5).
5. Den Livetest nach `docs/LIVE_TEST.md` durchgehen.

Entwicklung:

- Echtes Spotify, echtes Cloudflare mit seinem CPU-Limit und der Livetest sind noch ungeprüft. Getestet ist alles nur gegen ein nachgebautes Spotify.
- Eine frische unabhängige Fehler- und Sicherheitsprüfung fehlt für die Fixes 7eba355 und 501e79a und für den Radio-Umbau ab 6063d63.
- `npm run lint` schlägt fehl, weil alte Review-Kopien unter `.claude/worktrees/agent-*` eigene `biome.json` mitbringen. Die Ordner löschen, dann ist es wieder grün. Das Löschen war in der Sitzung nicht freigegeben.
- Bei 1024×768 liegt die Songkarte knapp unter der Bildschirmkante.
- Das Impeccable-Update scheitert bei Impeccable mit HTTP 404 (Issue #479). Der installierte Skill bleibt auf 4.3.1, später erneut versuchen.
