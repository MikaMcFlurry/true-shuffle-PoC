"""Spotify Web API helpers — all calls strictly sequential.

Functions:
- get_my_playlists     → list of {id, name, total_tracks}
- get_playlist_tracks  → (valid_uris, excluded_items)
- create_playlist      → {id, url}
- add_tracks_batch     → add URIs in ≤100-item chunks
"""

from __future__ import annotations

import httpx

_API_BASE = "https://api.spotify.com/v1"


# ---------------------------------------------------------------------------
# List playlists
# ---------------------------------------------------------------------------

async def get_my_playlists(token: str) -> list[dict]:
    """Return all playlists owned/followed by the current user.

    Each item: ``{"id": str, "name": str, "total_tracks": int}``.
    Paginates through all results.
    """
    playlists: list[dict] = []
    url: str | None = f"{_API_BASE}/me/playlists?limit=50"
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        while url:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("items", []):
                playlists.append(
                    {
                        "id": item["id"],
                        "name": item.get("name", "(untitled)"),
                        "total_tracks": item.get("tracks", {}).get("total", 0),
                        "owner": item.get("owner", {}).get("display_name", ""),
                    }
                )
            url = data.get("next")  # None when last page

    return playlists


# ---------------------------------------------------------------------------
# Fetch all tracks (paged) with filtering
# ---------------------------------------------------------------------------

async def get_playlist_tracks(
    token: str,
    playlist_id: str,
) -> tuple[list[str], list[dict]]:
    """Fetch every track URI from a playlist, filtering out bad items.

    Returns:
        (valid_uris, excluded_items)
        - valid_uris: deduplicated list of ``spotify:track:…`` URIs
        - excluded_items: list of ``{"uri": str|None, "reason": str}``
    """
    valid_uris: list[str] = []
    seen: set[str] = set()
    excluded: list[dict] = []

    url: str | None = (
        f"{_API_BASE}/playlists/{playlist_id}/tracks"
        f"?fields=items(track(uri,type,is_local,name)),next&limit=100"
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        while url:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()

            for item in data.get("items", []):
                track = item.get("track")

                # Unavailable / deleted placeholder
                if track is None:
                    excluded.append({"uri": None, "reason": "unavailable"})
                    continue

                uri = track.get("uri")
                track_type = track.get("type", "")
                is_local = track.get("is_local", False)

                # Local files
                if is_local:
                    excluded.append({"uri": uri, "reason": "local_file"})
                    continue

                # Episodes / non-tracks
                if track_type != "track":
                    excluded.append({"uri": uri, "reason": f"type:{track_type}"})
                    continue

                # Missing URI
                if not uri:
                    excluded.append({"uri": None, "reason": "no_uri"})
                    continue

                # Dedup
                if uri in seen:
                    excluded.append({"uri": uri, "reason": "duplicate"})
                    continue

                seen.add(uri)
                valid_uris.append(uri)

            url = data.get("next")

    return valid_uris, excluded


# ---------------------------------------------------------------------------
# Create playlist
# ---------------------------------------------------------------------------

async def create_playlist(
    token: str,
    user_id: str,
    name: str,
    *,
    public: bool = False,
    description: str = "",
) -> dict:
    """Create a new Spotify playlist.

    Returns ``{"id": str, "url": str}``.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "name": name,
        "public": public,
        "description": description,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{_API_BASE}/users/{user_id}/playlists",
            headers=headers,
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    return {
        "id": data["id"],
        "url": data.get("external_urls", {}).get("spotify", ""),
    }


# ---------------------------------------------------------------------------
# Add tracks in batches of ≤100
# ---------------------------------------------------------------------------

async def add_tracks_batch(
    token: str,
    playlist_id: str,
    uris: list[str],
    *,
    batch_size: int = 100,
) -> int:
    """Add *uris* to *playlist_id* in sequential batches.

    Returns the number of API calls made.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    calls = 0

    async with httpx.AsyncClient() as client:
        for start in range(0, len(uris), batch_size):
            chunk = uris[start : start + batch_size]
            resp = await client.post(
                f"{_API_BASE}/playlists/{playlist_id}/tracks",
                headers=headers,
                json={"uris": chunk},
            )
            resp.raise_for_status()
            calls += 1

    return calls


# ---------------------------------------------------------------------------
# Fetch a single playlist's metadata
# ---------------------------------------------------------------------------

async def get_playlist(token: str, playlist_id: str) -> dict:
    """Return basic metadata for a single playlist.

    Returns ``{"id", "name", "total_tracks", "owner"}``.
    """
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{_API_BASE}/playlists/{playlist_id}?fields=id,name,owner(display_name),tracks(total)",
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()

    return {
        "id": data["id"],
        "name": data.get("name", "(untitled)"),
        "total_tracks": data.get("tracks", {}).get("total", 0),
        "owner": data.get("owner", {}).get("display_name", ""),
    }


# ---------------------------------------------------------------------------
# Fetch current user's Spotify ID
# ---------------------------------------------------------------------------

async def get_current_user_id(token: str) -> str:
    """Return the Spotify user id for the token holder."""
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{_API_BASE}/me", headers=headers)
        resp.raise_for_status()
    return resp.json()["id"]
