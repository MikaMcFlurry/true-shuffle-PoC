"""Connect / disconnect flows for every provider.

One set of routes serves all connectors.  The differences between Spotify's
PKCE redirect, Google's confidential-client redirect and Apple's
browser-minted token are absorbed by
:class:`~providers.base.MusicProvider.begin_auth` and friends.
"""

from __future__ import annotations

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app import db
from app.config import get_settings
from app.deps import ensure_session_user, require_user_id
from providers.base import (
    AuthKind,
    ProviderError,
    ProviderNotConfigured,
)
from providers.registry import get_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])
templates = Jinja2Templates(directory="app/templates")

_STATE_KEY = "oauth_state"
_PENDING_KEY = "oauth_pending"


@router.get("/{provider_id}/login")
async def begin(request: Request, provider_id: str):
    """Start connecting *provider_id* to the current browser session."""
    await ensure_session_user(request)
    settings = get_settings()

    try:
        provider = get_provider(provider_id)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=f"Unknown provider {provider_id}"
        ) from exc
    except ProviderNotConfigured as exc:
        return templates.TemplateResponse(
            request, "connect_error.html",
            {"provider_id": provider_id, "detail": str(exc),
             "missing": _missing(provider_id)},
            status_code=503,
        )

    state = secrets.token_urlsafe(24)
    redirect_uri = settings.redirect_uri(provider_id)

    try:
        start = await provider.begin_auth(redirect_uri=redirect_uri, state=state)
    except ProviderError as exc:
        return templates.TemplateResponse(
            request, "connect_error.html",
            {"provider_id": provider_id, "detail": str(exc),
             "missing": _missing(provider_id)},
            status_code=getattr(exc, "status_code", 502),
        )

    request.session[_STATE_KEY] = state
    request.session[_PENDING_KEY] = {
        "provider": provider_id, **start.session_data
    }

    if provider.capabilities.auth is AuthKind.BROWSER_SDK:
        # Apple Music: the page itself mints the user token.
        return templates.TemplateResponse(
            request, "connect_apple.html",
            {
                "provider": provider.capabilities.as_dict(),
                "browser_config": start.browser_config,
            },
        )

    if provider.capabilities.auth is AuthKind.PASTED:
        # The credential is produced outside the browser and pasted in.
        return templates.TemplateResponse(
            request, "connect_paste.html",
            {
                "provider": provider.capabilities.as_dict(),
                "browser_config": start.browser_config,
            },
        )

    if not start.redirect_url:
        raise HTTPException(status_code=500, detail="Connector returned no redirect")
    return RedirectResponse(start.redirect_url, status_code=302)


@router.get("/{provider_id}/callback")
async def callback(
    request: Request,
    provider_id: str,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    """OAuth redirect target for Spotify and YouTube."""
    if error:
        return templates.TemplateResponse(
            request, "connect_error.html",
            {"provider_id": provider_id,
             "detail": f"The service reported: {error}", "missing": []},
            status_code=400,
        )
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    expected = request.session.pop(_STATE_KEY, None)
    pending = request.session.pop(_PENDING_KEY, {}) or {}
    if not expected or state != expected:
        # CSRF guard: the old PoC never checked this.
        raise HTTPException(
            status_code=400,
            detail="OAuth state mismatch — restart the connect flow",
        )
    if pending.get("provider") != provider_id:
        raise HTTPException(status_code=400, detail="OAuth flow/provider mismatch")

    provider = get_provider(provider_id)
    settings = get_settings()

    try:
        token = await provider.complete_auth(
            code=code,
            redirect_uri=settings.redirect_uri(provider_id),
            session_data=pending,
        )
        identity = await provider.identify(token)
    except ProviderError as exc:
        return templates.TemplateResponse(
            request, "connect_error.html",
            {"provider_id": provider_id, "detail": str(exc), "missing": []},
            status_code=getattr(exc, "status_code", 502),
        )

    user_id = await ensure_session_user(request)
    await db.upsert_provider_account(
        user_id=user_id,
        provider=provider_id,
        provider_user_id=identity.provider_user_id,
        display_name=identity.display_name,
        market=identity.market,
        product_tier=identity.product_tier,
        token=token.to_dict(),
        scope=token.scope,
    )
    return RedirectResponse("/library", status_code=303)


@router.post("/{provider_id}/browser")
async def browser_callback(request: Request, provider_id: str):
    """Accept a credential minted in the page (Apple Music MusicKit)."""
    provider = get_provider(provider_id)
    if provider.capabilities.auth not in (AuthKind.BROWSER_SDK, AuthKind.PASTED):
        raise HTTPException(status_code=400, detail="This provider uses a redirect flow")

    payload = await request.json()
    try:
        token = await provider.complete_browser_auth(payload)
        identity = await provider.identify(token)
    except ProviderError as exc:
        raise HTTPException(
            status_code=getattr(exc, "status_code", 502), detail=str(exc)
        ) from exc

    user_id = await ensure_session_user(request)
    await db.upsert_provider_account(
        user_id=user_id,
        provider=provider_id,
        provider_user_id=identity.provider_user_id,
        display_name=identity.display_name,
        market=identity.market,
        product_tier=identity.product_tier,
        token=token.to_dict(),
        scope=token.scope,
    )
    return JSONResponse({"status": "connected", "redirect": "/library"})


@router.post("/{provider_id}/disconnect")
async def disconnect(request: Request, provider_id: str):
    """Remove stored credentials for one service."""
    user_id = await require_user_id(request)
    await db.delete_provider_account(user_id, provider_id)
    return JSONResponse({"status": "disconnected", "provider": provider_id})


@router.get("/signout")
async def signout(request: Request):
    """Drop the browser session.

    Stored credentials survive so the same handle can come back — use
    *disconnect* to actually delete them.
    """
    request.session.clear()
    return RedirectResponse("/", status_code=303)


def _missing(provider_id: str) -> list[str]:
    from providers.registry import try_get_provider

    provider = try_get_provider(provider_id)
    return provider.missing_config() if provider else []


@router.get("/status", response_class=HTMLResponse)
async def status_redirect():
    return RedirectResponse("/connect", status_code=303)
