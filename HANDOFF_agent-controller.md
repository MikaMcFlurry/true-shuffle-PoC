# Handoff: Controller Mode

**Ziel:** Übergabe des Controller Mode (Queue-Buffer N=5, Polling, Hard Override, Skip-Handling, Device Handling, sequentielle Player-Calls).

## 1. Controller Flow
- **Start**: Der Prozess startet in `create_or_resume_run()`, welche das Array für die gesamte gemischte Playlist in der SQLite-DB anlegt. Danach ruft `start_playback()` die API für ein aktives Spotify-Gerät ab. Falls gefunden, wird der erste Track explizit gestartet (`PUT /me/player/play`) und der Buffer befüllt.
- **Queue-Fill**: `_fill_buffer()` durchläuft eine Schleife (iterativ) bis zur Grenze `cursor + buffer_size` (N=5). Fehlende Tracks werden per `POST /me/player/queue` (strictly sequential) angefügt. Der Tracker merkt sich den Fortschritt in `queued_until_index`.
- **Poll**: Die asynchrone Task `_poll_loop()` erfragt im Abstand von 3 Sekunden via `_poll_playback()` den Player-Status, solange der Controller auf `PLAYING` steht.
- **Advance/Skip**: Stimmt der spielende Track mit `order[cursor + 1]` überein (oder bis zu +5 für Multi-Skips), geht der Controller von einem legitimen "Natural Advance / Skip" aus. Der `cursor` rückt vor, und `_fill_buffer` fügt der Queue wieder exakt die entfernten Titel hinten an.
- **Override**: Ist der Track gänzlich fremd (weder der erwartete noch einer der nächsten Puffer-Titel), feuert `_hard_override()`. Dies zwingt den Player mit einem harten `PUT /play` zurück auf `order[cursor]` und reiht den Buffer ab dieser Stelle neu ein.

## 2. "Never play foreign track" Mechanism
Um zuverlässig nur definierte Tracks zu spielen, wird folgendes Muster angewendet:
- **Queue Buffer (N=5)**: An die Web-API werden maximal die nächsten 5 gültigen Lieder an Spotifys Ende der Queue gereiht. Skripts aus Sicht des Nutzers sind somit möglich und fühlen sich nativ an.
- **Hard Override**: Läuft unerwarteter Inhalt (außerhalb der N=5), löst die 3-Sekunden-Polling-Logik aus. Sie erzwingt die Unterbrechung durch einen expliziten Play-Befehl (`PUT /me/player/play` mit `position_ms: 0` und `uris: [track_uri]`) auf den eigentlich vorgesehenen Track und resetten den `queued_until_index`.

## 3. Sequentielle Player-Calls & Device Activation Behavior
- **Sequenzialisierung**: In `spotify_client.py` liegt ein generisches Dictionary `_player_locks: dict[str, asyncio.Lock]`. Jeder Call auf Web-API (/play, /queue, /devices) fordert den Lock pro `spotify_user_id` an. Es können keine parallelen Writes in die Queue stattfinden.
- **Device Discovery & UX**: `_find_active_device()` iteriert über die Liste verfügbarer Spotify-Player (`GET /me/player/devices`). Ist kein Device explizit "active" und auch keins fallweise auswählbar (leere Liste), bricht der Startvorgang ab. Die State Machine wechselt auf `NO_DEVICE` und meldet die exakte UX Copy: *"Kein aktives Spotify-Gerät gefunden. Öffne Spotify und drücke Play, dann klicke hier erneut."*

## 4. Minimaler Smoke Test
Ein Aufruf des Backends / Test Runners schlägt momentan aufgrund von Python 3.9 Kompatibilität und Abhängigkeiten ab:
- **Ausführung**: `pytest` über `.venv\Scripts\pytest.exe`.
- **Verhalten & Ergebnis**: Der Startup crasht mit dem Fehler `TypeError: Unable to evaluate type annotation 'str | None'` und `ModuleNotFoundError: No module named 'itsdangerous'`.
- **Fazit**: Die App bootet ohne das Hinzufügen von `itsdangerous` und Fixen des Python-3.10-Typing in Pydantic nicht. Ein vollständiger Test bis zum Device-Request in der UI (geschweige Spotify Premium Skip-Logs) bricht deshalb vorher in der FastAPI-Middleware Collection ab.

## 5. Offene Tasks (Konkret)
1. **Python 3.9 Typing reparieren**: In `app/controller.py` oder dort genutzten Modellen (z. B. Routen) die Union-Types `str | None` zu `typing.Optional[str]` auflösen oder alternativ das Paket `eval_type_backport` zur `requirements.txt` hinzufügen.
2. **Abhängigkeit fixen**: Das fehlende Paket `itsdangerous` zur `requirements.txt` hinzufügen, da Starlettes `SessionMiddleware` ohne dieses Paket direkt beim Booten crasht.
3. **Queue-Leftovers bewerten**: Prüfen, ob nach einem `_hard_override()` alte Fragmente in Spotifys Liste hängen bleiben (Spotify hat keine "Clear Queue" API). Möglicherweise müssen diese Leftovers nach einem Hard-Override programmatisch mit schnellen "Skips" durch iteriert werden.

## 6. Known Pitfalls / Risks
- **Polling Timing Margin (3s)**: Zwischen manuellem Fremd-Track-Start in der Spotify App und der Reaktion des Controllers (`_hard_override`) liegen bis zu ~3 Sekunden. "Never play foreign track" ist somit streng genommen "höchstens 3 Sekunden lang".
- **Rate Limit Gefahr (HTTP 429)**: Obwohl Calls locked sind: Häufige Skips in Kombination mit N=5 Repopulation können Spotifys Request-Quotas für Playable-Endpoints ausreizen.
- **Spotify Rest-Queues**: Hat der Benutzer manuell bereits eine tiefe Nutzer-Queue in Spotify, könnte Spotify diese priorisieren. Der Buffer reiht nämlich lediglich hinten in die Warteschlange ein.

## 7. Next Steps
1. **Dependencies heilen**: `requirements.txt` um `itsdangerous` ergänzen und Unions `|` bereinigen.
2. **Echte App Exploration**: Spotify Premium Client aufrufen, `/controller/ui` öffnen, Playlist verknüpfen und Response-Zeiten / Delay beim "Hard Override" in Reality auswerten.
3. **Integration-Tests um "Multi-Skip" ergänzen**: Mocks in Unit Tests so aufziehen, dass simulierte Tracker einen Wert auf `cursor + 3` spielen, um die Logik aus `_poll_playback()` zu verifizieren.
