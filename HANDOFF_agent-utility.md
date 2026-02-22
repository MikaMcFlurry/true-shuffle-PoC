# Utility Mode Handoff

## What’s Implemented
- **Complete Pagination**: `get_playlist_tracks` fetches all track pages using the `next` cursor until the end.
- **Filtering & Deduplication**: Excludes local files, podcasts, and missing URIs. Removes duplicate tracks robustly per-run using a `seen` set (`app/spotify.py`).
- **Shuffle Engine**: Uses Python's native `random.shuffle()` (Fisher-Yates) in-place (`app/utility.py`).
- **Playlist Creation**: Successfully creates a new target playlist titled "🔀 {Original Name}".
- **Batching**: Tracks are added to the target playlist sequentially in exact chunks of `≤ 100` tracks (`add_tracks_batch`).
- **Run Tracking & Resuming**: Checks SQLite DB for an existing run to prevent duplicate target creation.
- **Progress UI**: **No real-time progress exists yet.** The `POST /utility/create` request simply blocks the browser synchronously during all Spotify API roundtrips and only renders the result template at the end.

## How to Run the Utility Flow
1. **Start the Application:** `uvicorn app.main:app --reload --port 8000`
2. **Login:** Navigate to `http://localhost:8000/login` to authenticate via Spotify PKCE.
3. **Select Playlist:** Go to `http://localhost:8000/playlists` and click the **Shuffle (Utility Mode)** form button for a playlist.
4. **Wait (Blocking):** The request goes to `POST /utility/create?playlist_id=...` where it blocks.
5. **Expected Output:** Renders the `utility_result.html` template. It displays "✅ Shuffle Complete!", shows the total tracks added, lists any skipped/unavailable items, and provides a direct link to the new Spotify playlist.

## Open Tasks
1. **`app/utility.py` (Missing Progress UI / Background Execution)**
   - *Behavior*: Lengthy blocking execution inside the route handler instead of a background task. Needs an SSE or polling mechanism combined with DB status updates (`progress_current`, `progress_total`) to show user progress.
2. **`app/spotify.py` (Missing 429 Retry Backoff)**
   - *Behavior*: `httpx.AsyncClient` is currently instantiated natively per function. Spotify's `429 Too Many Requests` will cause the flow to crash on large lists instead of honoring the `Retry-After` header.
3. **`app/utility.py` (Resuming Partial Batches)**
   - *Behavior*: While it correctly identifies an existing run, it does not gracefully resume a partially-added playlist if the process crashed midway through adding batch chunks.

## Known Issues
- **429 Rate Limits**: Prone to hitting limits and crashing on massive playlists since no backoff logic exists.
- **Large Playlists Timeout**: Because the request blocks server-side, multi-thousand song playlists risk facing HTTP proxy or browser connection timeouts. 
- **Unavailable Items**: Correctly handled (tracked as `track: None` / missing URIs and skipped). They are properly surfaced in the final UI under the `excluded_items` warning.

## Next Steps
1. **Implement HTTP Client Wrapper**: Replace raw `httpx.AsyncClient` instances in `app/spotify.py` with an auto-retrying client to gracefully handle 429/50x errors.
2. **Refactor to Background Worker**: Shift the logic of `utility_create` into an `asyncio.create_task` (or similar worker) to process large iterations asynchronously and instantly return a redirect to a loading view.
3. **Implement Polling UI**: Create a `/utility/status/{run_id}` endpoint and a frontend view that periodically polls the DB to show a track progress bar and redirects to the final result once `status = 'completed'`.
