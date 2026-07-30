"""Request-scoped helpers: identity, ownership, and error translation."""

from __future__ import annotations

import secrets
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request

from app import db
from providers.base import ProviderError

_SESSION_KEY = "ts_user"


async def current_user_id(request: Request) -> Optional[int]:
    """The local user id for this browser session, if any."""
    handle = request.session.get(_SESSION_KEY)
    if not handle:
        return None
    return await db.get_or_create_user(handle)


async def require_user_id(request: Request) -> int:
    user_id = await current_user_id(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Nicht angemeldet.")
    return user_id


async def ensure_session_user(request: Request) -> int:
    """Return the session's user, creating an anonymous local identity.

    This PoC has no password login: a browser session *is* the identity, and
    streaming accounts are attached to it.  The handle is a random opaque
    string so run ids are not guessable across sessions.
    """
    handle = request.session.get(_SESSION_KEY)
    if not handle:
        handle = f"local-{secrets.token_urlsafe(12)}"
        request.session[_SESSION_KEY] = handle
    return await db.get_or_create_user(handle)


async def require_run(request: Request, run_id: int) -> Dict[str, Any]:
    """Load a run **owned by the caller**.

    The Spotify-only PoC looked runs up by id alone, so any signed-in user
    could advance or export another user's run by guessing an integer.  Here
    ownership is part of the query, and a foreign run is a 404 — not a 403,
    which would confirm the id exists.
    """
    user_id = await require_user_id(request)
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    return run


def http_error(exc: ProviderError) -> HTTPException:
    """Translate a connector failure into an HTTP response."""
    return HTTPException(status_code=getattr(exc, "status_code", 502), detail=str(exc))
