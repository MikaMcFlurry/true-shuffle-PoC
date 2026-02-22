# true-shuffle PoC

> Deterministic, unbiased shuffle for Spotify playlists — local & zero-cost.

See **[SPEC_TRUE_SHUFFLE_POC.md](SPEC_TRUE_SHUFFLE_POC.md)** for full product spec.

---

## Setup

```bash
git clone https://github.com/<YOUR_USER>/true-shuffle-PoC.git
cd true-shuffle-PoC

python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows (PowerShell):
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

---

## Environment Variables

Copy the example and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SPOTIFY_CLIENT_ID` | ✅ | From Spotify Developer Dashboard |
| `BASE_URL` | ✅ | `http://localhost:8000` |
| `SECRET_KEY` | ✅ | Any random string (session signing) |
| `DB_PATH` | ✅ | `./data/true_shuffle.db` |
| `QUEUE_BUFFER_SIZE` | ❌ | Default `5` — Controller Mode buffer |

---

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

Open: <http://localhost:8000>

---

## Tests

```bash
pytest
```

---

## Lint

```bash
ruff check .
```

---

## License

TBD (PoC — private use only)