# True Shuffle continuation

Start with `CODEX_START.md` and `docs/persistent-queue/ANALYSIS.md`. The current branch implements rate-limit safeguards and a new UI foundation; persistent account identity, provider-side resume after a True Shuffle pause, and native HA/MA integration are still open.

Use the project-local Impeccable skill in `.agents/skills/impeccable/SKILL.md` for UI work. The owner chose Listening Room (calm dark music-player); preserve that direction and existing rules, discovery, favourites, exclusions and history. Treat old design concepts and historical verification counts as historical.

FastAPI / Jinja / vanilla CSS and ES modules, no frontend build required. Do not scan or edit `.venv/` or vendored `.agents/skills/` as application code. Use an isolated demo database for tests; never replace the user's database or expose credentials. Preserve ownership checks and one active controller per provider account. Never mark tracks heard solely from elapsed wall time. No merge or production deploy without explicit release authorization.

Checks: `.venv/bin/python -m pytest -q`, `.venv/bin/ruff check .`; opt-in browser checks with `TS_CHROMIUM_PATH` if needed: `.venv/bin/python -m pytest tests/browser -m browser -q`.
