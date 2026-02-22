# True-Shuffle PoC – KI Handoff

Dieses Dokument fasst den aktuellen Projektstand, die verschiedenen Modi und die nächsten operativen Schritte zusammen. Es dient zur nahtlosen Übergabe an Folge-Agenten (z. B. Claude Pro).

## TL;DR
- **Basis-Architektur & Auth:** FastAPI, SQLite (`aiosqlite`), Spotify PKCE-Login inkl. Auto-Refresh sind aufgesetzt.
- **Shuffle Engine:** Core Fisher-Yates Algorithmus, Deduplizierung und grundlegende Architektur stehen bereit.
- **Utility Mode:** Paginierter Abruf von Playlists, Shufflen und Speichern in Batches (<100) als "neue" Spotify-Playlist ist implementiert (leidet noch unter synchronem Blocking).
- **Controller Mode (Premium):** Strict-sequential Locks, N=5 Queue-Buffer, Hard-Override für flüssiges Abspielen ohne fremde Tracks sind entworfen, erfordern aber Feintuning.
- **Export/Import:** Spezifikation für Token-freien JSON Dump/Import (für Run-State, ohne Credentials) ist definiert, Code aber noch nicht implementiert.

---

## Current Repo State

- **Features implementiert (theoretisch funktionsfähig):**
  - Spotify PKCE Auth, SQLite Token Store, Session Middleware.
  - Playlist Fetcher, Deduplizierung und Fisher-Yates Shuffle Engine.
  - Controller Mode State-Machine (Buffer, Polling, Override).
  - Web UI Templates (Base, Playlists, Controller).

- **Läuft aktuell NICHT / Bricht ab (Blocker):**
  - **Uvicorn Startup:** Bricht ab, da die Library `itsdangerous` in `requirements.txt` fehlt (notwendig für SessionMiddleware).
  - **Pytest/Typing:** Python 3.9 Inkompatibilitäten (`str | None` in `app/auth.py`), weshalb FastAPI/Pydantic crasht und Pytest mit Collection Errors abbricht.
  - **Utility Request Timeout:** Massive Playlists blockieren synchron den Browser/Server (Fehlen eines Background-Workers).

---

## Open Tasks (Priority)

### Core
1. **Dependencies heilen:** `itsdangerous` zur `requirements.txt` hinzufügen.
2. **Type-Syntax fixen:** Python 3.9 kompatible Type-Hints sicherstellen (z. B. `Optional[str]` statt `str | None` in `app/auth.py`), damit die App bootet und Tests durchlaufen.
3. **HTTP Client Wrapper implementieren:** Auto-Retry Logic (`Retry-After` Header) beim Aufruf der Spotify-API global anwenden.

### Controller
1. **Multi-Skip Integration Tests:** Mocks in Tests simulieren (`cursor + 3`), um die Logik in `_poll_playback()` (Controller Advance/Override) zu verifizieren.
2. **Spotify Premium Smoke-Test:** Begehen des Playbacks mit echtem Device, Evaluierung des Delays beim "Hard Override" in Reality.
3. **Queue-Leftovers identifizieren:** Verhalten von Spotify analysieren, wenn Titel in der Queue nach einem Override stehen bleiben.

### Utility
1. **Background Worker Refactor:** Die Erstellung der Playlists (Utility Mode) aus dem kritischen Request-Lifecycle nehmen und in einen Async-Task auslagern.
2. **HTTP Client Async Wrapper:** Rate Limits (`429`) in den Spotify Client Requests sauber mittels Capped Backoff abfangen.
3. **Polling / SSE UI (Progress):** `/utility/status/{run_id}` Endpunkt & Frontend-Status-Bar für lange Playlist-Kopiervorgänge implementieren.

### QA (Export/Import/Similarity)
1. **Green-State Pytest:** Die Testumgebung bereinigen (File-Locks in SQLite Fixes), damit `pytest` jederzeit fehlerfrei funktioniert.
2. **Export / Import Endpoints:** FastAPI-Endpunkte & Pydantic-Models erstellen (strikter Ausschluss von Tokens via `exclude={"access_token", "refresh_token"}`).
3. **Similarity Check Logik:** Metrik (z.B. Nachbarschafts-Check) programmieren, die einen Neu-Shuffle triggert, falls die alte Liste zu ähnlich ist.

---

## How to Run

**1. Setup & Env Variables:**
```bash
python -m venv .venv
source .venv/bin/activate  # macOS / Linux
# Unter Windows: .venv\Scripts\Activate.ps1

pip install -r requirements.txt
cp .env.example .env
```
👉 *Passe die Werte in `.env` an (u. a. `SPOTIFY_CLIENT_ID`). Niemals Secrets nach Git committen.*

**2. Start Application:**
```bash
uvicorn app.main:app --reload --port 8000
```
**URLs:**
- Root: `http://localhost:8000/`
- Login: `http://localhost:8000/login`
- Utility/Playlists: `http://localhost:8000/playlists`
- Controller UI: `http://localhost:8000/controller/ui` *(Unverified, genauer Pfad in routes überprüfen)*

---

## How to Test

**Automatisierte Tests:**
```bash
pytest
```
*(Achtung: Momentan schlägt Pytest beim Sammeln der Tests wegen des Typing-Fehlers fehl.)*

**Manuelle Browser-Schritte (Utility Mode):**
1. Login über `/login` (PKCE Ablauf checken).
2. Bei `/playlists` neben einer Liste auf "Shuffle (Utility Mode)" klicken.
3. Warten, bis der Request beendet ist (aktuell synchrones Warten).
4. `utility_result.html` Verifizierung: Stimmt die Song-Anzahl mit der neu in Spotify aufgetauchten Playlist überein?

**Manuelle Browser-Schritte (Controller Mode - Premium Only):**
1. Native Spotify App (Desktop/Mobile) öffnen und Titel starten (Device Activation).
2. Im Controller-UI eine Playlist starten.
3. In der *nativen* Spotify App Skip-Buttons verwenden (Multi-Skip oder Fremd-Titel starten).
4. Beobachten, ob das Backend den `_hard_override()` erfolgreich triggert.

---

## Known Issues / Risks

- **429 Rate Limits / Browser Timeout:** Riesen-Playlists stürzen im Utility Mode derzeit ab. Batching läuft, ist aber nicht durch Background-Worker geschützt.
- **Premium Required für Controller:** Das API-Feature "App-basiertes Playback" (`PUT /me/player/play`) sperrt Spotify-Free User aus.
- **Device Activation:** Die Controller-API crasht oder fällt in einen endlosen `NO_DEVICE` State, sofern der Nutzer Spotify nicht anderweitig aktiv geöffnet/als Target deklariert hat.
- **Spotify Queue Logic & Polling Delay:** Kein API Request für "Clear Queue" in Spotify vorhanden. Es kann bis zu ~3 Sekunden dauern, ehe ein fremder manueller Track-Klick im Controller per Override abgefangen wird (Polling Margin).
- **SQLite Database Locked Fehler:** Unter Windows-basierten Test-Ausführungen (`pytest`) können fehlende "Session Cleanups" asynchrone File-Locks erzeugen (Flaky Tests).

---

## Next 60 Minutes Plan

1. **Bugfixes & Baseline:** In `requirements.txt` das Paket `itsdangerous` eintragen und `app/auth.py` (oder wo relevant) Type-Hints von `str | None` auf `Optional[str]` ändern.
2. **Verify Tests:** Validierung, dass `pytest` & `uvicorn` sauber und fehlerfrei initialisieren.
3. **Utility Worker Refactoring:** Endpunkt für Playlists async umschreiben, damit kein Timeout die App blockiert.
4. **Smoke-Test Setup:** Einen "richtigen" Controller-Lauf mit einem Spotify Premium-Account im integrierten Browser simulieren und Ergebnisse sichten.
