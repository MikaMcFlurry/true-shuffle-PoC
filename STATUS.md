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

**Total Tests:** 59/59 passing · **Ruff:** clean

## Project Structure
```
app/
├── __init__.py
├── auth.py             # Spotify OAuth PKCE
├── config.py           # pydantic-settings
├── db.py               # async SQLite (users, runs, skipped_tracks)
├── main.py             # FastAPI app factory
├── routes_controller.py # Controller Mode
├── routes_export.py    # Export/Import
├── routes_utility.py   # Utility Mode
├── spotify_client.py   # Spotify API client
├── static/style.css    # Dark-mode CSS
└── templates/
    ├── base.html
    ├── controller.html
    ├── playlists.html
    └── utility_result.html
core/
├── __init__.py
├── exporter.py         # JSON export/import
├── models.py           # Pydantic models
└── shuffle.py          # Fisher-Yates + guards
tests/                  # 59 tests
```

## Git Commits (not pushed)
- `da93f72` Foundation files
- `924b8c4` Ticket 1 — Project scaffold
- `4932400` Ticket 2 — SQLite setup
- `419c138` Ticket A — SpotifyClient
- `a0001a4` Ticket B — Shuffle engine
- `ca2f48b` Ticket C — Utility Mode
- `92db76d` Ticket D — Controller Mode
- `acf8b1a` Ticket E — Export/Import

## Next Steps
- 👉 **See `HANDOFF.md`** for the current consolidated state, known issues, and immediately actionable tasks for the next steps.
- Browser integration testing with real Spotify credentials
- Ticket F visual polish (optional)
- Push to GitHub when approved
