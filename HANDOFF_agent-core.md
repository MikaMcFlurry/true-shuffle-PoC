# Handoff: Core-Basis (Agent-Core)

## What’s implemented
- **FastAPI Foundation (`app/main.py`)**: Startup/Shutdown Hooks für die Datenbank und Session-Middleware konfiguriert.
- **SQLite Database (`app/db.py`)**: Async-Zugriff (`aiosqlite`) mit Tabellen für `users`, `runs` und verschlüsselten(?) `tokens`. Upsert-Mechanik vorhanden.
- **Spotify OAuth PKCE Flow (`app/auth.py`)**: Security Best-Practices (kein Client Secret) implementiert. Endpunkte `/login`, `/callback`, `/me`, `/logout` persistieren die Token in der DB und tracken User über ein signiertes Session-Cookie.
- **Spotify HTTP Wrapper (`app/spotify_client.py`)**: Resilienter API-Client (`spotify_request`) mit Auto-Refresh, 429 Retry-After (+Jitter) und 5xx Exponential Backoff. Timeout-Handling integriert.
- **Configuration (`app/config.py`)**: Settings-Management via `pydantic-settings` und Type-Hints.

## How it works
- **PKCE flow**: Start an `/login` -> Generierung von `code_verifier/challenge`. Redirect zu Spotify. Anschließend nimmt `/callback` den Authorization Code entgegen, tauscht diesen gegen ein Token aus und speichert den Benutzer (inkl. Spotify-ID) als Session-Cookie ab.
- **Token refresh**: Vor jedem Call prüft `_get_access_token` proaktiv das Verfallsdatum des Tokens (Puffer < 60s) und erneuert es in der DB via `refresh_token`. Bei direktem 401 auf der Spotify-API erfolgt ein Retry mit frischem Token.
- **Retry policy**: Capped Exponential Backoff bei 5xx Server-Fehlern. Bei `HTTP 429` blockiert der Request `Retry-After`-Sekunden plus Jitter, bevor der Versuch wiederholt wird. 

## Config
Benötigte Environment-Variablen (Werte in `.env.example` enthalten):
- `SPOTIFY_CLIENT_ID`
- `BASE_URL`
- `SECRET_KEY`
- `DB_PATH`
- `QUEUE_BUFFER_SIZE`

## Open tasks
1. **Abhängigkeiten ergänzen**: `requirements.txt` muss `itsdangerous` beinhalten, da App-Start mit `ModuleNotFoundError` aufgrund der `SessionMiddleware` aktuell abbricht.
2. **Type-Syntax fixen**: `app/auth.py` verwendet `str | None`, was Pydantic auf dem lokalen System (Python 3.9) in FastAPI-Parametern crashen lässt (`TypeError: Unable to evaluate type annotation`). Muss auf `Optional[str]` geändert werden.
3. **Tests erweitern**: `tests/test_auth.py` bzw. andere Testmodule fehlen oder crashen aufgrund der Collection-Fehler um den Endpunkten eine Mocking-Umgebung (für die Spotify-API) zur Verfügung zu stellen.

## Known issues
- **401 Refresh Edge Cases**: Verliert der User die App-Berechtigungen auf Spotify-Seite, schlägt der automatische Refresh in Wrappern ohne Weiterleitung zu `/login` fehl. Stattdessen knallt `SpotifyAPIError` hoch.
- **429 Handling**: Worker/Player-API sollen für die Zukunft sequenziell laufen (Lock-Mechanismus) – aktuell sperrt die Pause von einem fehlerhaften Request nur diese Coroutine, jedoch gibt es keine App/Global-Lösung um Parallel-Flooding anderer Requests zur gleichen Zeit zu drosseln.

## Next steps
1. Abhängigkeit `itsdangerous` in `requirements.txt` installieren, um `uvicorn` erfolgreich starten zu können.
2. Die FastAPI Type-Hints Python 3.9-kompatibel (`typing.Optional`) machen (`app/auth.py`), sodass Pytest keine Collection-Errors wirft.
3. Den Shuffle Engine PoC sowie die Controller-Logik andocken und erste Player-API Request implementieren (strikt sequenziell).

---

## 💻 Checkergebnisse (Lokal ausgeführt)
- **`pytest` Check**: `FAIL` 
  - *Fehlermeldung (Collection)*: `TypeError: Unable to evaluate type annotation 'str | None'` und `ModuleNotFoundError: No module named 'itsdangerous'`. 
- **`uvicorn` Check**: `FAIL` 
  - *Fehlermeldung (Startup)*:  `ModuleNotFoundError: No module named 'itsdangerous'` (ausgehend von `starlette.middleware.sessions`).
