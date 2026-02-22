# true-shuffle PoC (Spotify-only)

A local, zero-cost proof of concept for **true-shuffle** on **Spotify**.

## What this PoC proves

### 1) Utility Mode (safe & robust)
- Reads a Spotify playlist (supports large playlists via pagination)
- Removes duplicates (**each track max. 1× per run**)
- Shuffles (unbiased Fisher–Yates)
- Creates a **new Spotify playlist** with that exact shuffled order (writes in **batches of 100**)
- You then play it **linearly** in the regular Spotify app

### 2) Controller Mode (Premium-only, private testing)
- Keeps a persistent **external run queue** (order + cursor)
- Starts the exact next track on your active Spotify device
- Uses a **queue buffer (next 5 tracks)** + **hard override** so that **no random/foreign track is briefly played**
- If you skip: the skipped track is considered played and it immediately moves to the next true-shuffle track

> Note: Spotify playback control requires **Spotify Premium**.

---

## Requirements
- Python **3.11+**
- Spotify account (Premium required for Controller Mode)
- Spotify Developer App (Client ID)

---

## Spotify Developer App Setup
1. Create an app in the Spotify Developer Dashboard
2. Add this Redirect URI:
   - `http://localhost:8000/callback`
3. Copy your **Client ID**

---

## Local Setup
```bash
git clone https://github.com/<YOUR_USER>/true-shuffle-PoC.git
cd true-shuffle-PoC

python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows (PowerShell):
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

Create a `.env` file (based on `.env.example`) and set at minimum:
- `SPOTIFY_CLIENT_ID=...`
- `BASE_URL=http://localhost:8000`
- `SECRET_KEY=...` (any random string)
- `DB_PATH=./data/true_shuffle.db`

---

## Run
```bash
uvicorn app.main:app --reload --port 8000
```

Open in browser:
- `http://localhost:8000/login`
- After login:
  - `http://localhost:8000/playlists`

---

## Usage

### Utility Mode
1. Go to `/playlists`
2. Pick a playlist
3. Click **Create Shuffled Copy**
4. Open the resulting playlist in Spotify and play normally

### Controller Mode
1. Go to `/playlists`
2. Pick a playlist
3. Click **Start/Resume Controller Run**
4. Ensure you have an **active Spotify device**:
   - Open Spotify on a device (desktop/mobile) and press Play once
5. Use buttons:
   - **Next**: marks current as played and starts the next true-shuffle track
   - **Resume**: continues from saved cursor
   - **Shuffle refresh**: generates a new shuffled order (only on explicit click)

---

## Product Rules (implemented by this PoC)
- **Dedup**: each track max. 1× per run
- **Unavailable / local / episodes / non-track**: skipped and **NOT** marked as played (reported separately)
- **Resume**: per `(user, playlist, mode)` there is one active run that resumes with the same order + cursor
- **New order** only when:
  - the run completed (all tracks played), or
  - user explicitly clicks **Shuffle refresh**
- **Avoid “too similar” orders** after refresh: retries reshuffle up to 5 times if similarity threshold is hit

---

## Export / Import (for collaboration)
This PoC supports exporting/importing **run state** as JSON to share with another developer.

Important:
- **OAuth tokens are never exported/imported**
- Export contains only run data (order, cursor, etc.)

---

## Tests
```bash
pytest
```

---

## Troubleshooting
- **No active device**: open Spotify on a device and press Play once, then reload.
- **Premium required**: Controller Mode needs a Premium account.
- **Rate limit (429)**: the client respects `Retry-After` and retries automatically.

---

## Security Notes
- Never commit `.env`
- Never export or share OAuth tokens
- This PoC is for private testing only

---

## License
TBD (PoC)