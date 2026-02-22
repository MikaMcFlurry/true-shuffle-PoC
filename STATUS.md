# STATUS — true-shuffle PoC

## ✅ Completed

| Ticket | Summary | Tests |
|--------|---------|-------|
| Foundation | SPEC, scaffold, SQLite, OAuth PKCE | 15 |
| A — SpotifyClient | Retry/refresh/lock, 9 API methods | 8 |
| B — Shuffle Engine | Fisher-Yates, dedup, similarity guard | 18 |
| C — Utility Mode | `/playlists`, "Create Shuffled Copy", templates, CSS | 6 |
| D — Controller Mode | Hard-override, queue buffer, cursor persist, controller UI | 5 |
| E — Export/Import | Run state as JSON (no tokens), download/upload | 7 |
| F — UI & Integration | `base.html`, `style.css`, all routers wired | — |

**Total Tests:** 61/61 passing · **Ruff:** clean

## Project Structure
```
app/
├── __init__.py
├── auth.py             # Spotify OAuth PKCE
├── config.py           # pydantic-settings
├── db.py               # async SQLite (users, runs, skipped_tracks)
├── main.py             # FastAPI app factory + root route
├── routes_controller.py # Controller Mode
├── routes_export.py    # Export/Import
├── routes_utility.py   # Utility Mode
├── spotify_client.py   # Spotify API client
├── static/style.css    # Dark-mode CSS
└── templates/
    ├── base.html
    ├── controller.html
    ├── home.html           # Landing page (NEW)
    ├── playlists.html
    └── utility_result.html
core/
├── __init__.py
├── exporter.py         # JSON export/import
├── models.py           # Pydantic models
└── shuffle.py          # Fisher-Yates + guards
tests/                  # 61 tests
pyproject.toml          # pytest + ruff config (NEW)
```

## Latest Changes (G — Browser-Flow Fixes)

**What changed:**
- Added `GET /` root route with landing page (`home.html`): shows login button for guests, "Go to Playlists" for logged-in users.
- Fixed `/login` returning raw 500 JSON when `SPOTIFY_CLIENT_ID` is not set — now returns a human-readable HTML error with setup instructions.
- Fixed Starlette `TemplateResponse` deprecation warnings across all routes (request as first positional arg).
- Added `pyproject.toml` with `asyncio_mode = "auto"` for pytest and ruff target config.
- Added 2 new tests for root route behavior.

**How to test:**
1. `python -m pytest -v` — 61/61 should pass, 0 warnings.
2. `python -m uvicorn app.main:app --port 8000` — visit `http://localhost:8000/`:
   - Without `.env`: landing page shows "Login with Spotify" button.
   - Click Login: shows config error page (not a raw 500 trace).
   - With valid `.env`: login redirects to Spotify, then `/playlists`.

**What's still open:**
- `/controller/ui` GET route does not exist (only POST `/controller/start`).
- No error page template (generic HTML error pages for auth-guarded routes).
- Utility Mode still blocks synchronously on large playlists (no background worker).
- No run history / dashboard page.

## Git Commits
- `da93f72` Foundation files
- `924b8c4` Ticket 1 — Project scaffold
- `4932400` Ticket 2 — SQLite setup
- `419c138` Ticket A — SpotifyClient
- `a0001a4` Ticket B — Shuffle engine
- `ca2f48b` Ticket C — Utility Mode
- `92db76d` Ticket D — Controller Mode
- `acf8b1a` Ticket E — Export/Import
- `e848a47` HANDOFF.md
- *(pending)* Ticket G — Browser-flow fixes (root route, login error, TemplateResponse fix)

## Next Steps
- Add `/controller/ui` GET route for direct browser navigation
- Background worker for Utility Mode (async task with progress)
- Run history / dashboard page
- Browser integration testing with real Spotify credentials
