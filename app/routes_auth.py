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
from app.crypto import VaultError
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
            status_code=404, detail=f"Unbekannter Dienst {provider_id}."
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
        raise HTTPException(
            status_code=500,
            detail="Der Connector hat keine Weiterleitung zurückgegeben.",
        )
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
        raise HTTPException(status_code=400, detail="Es fehlt der Autorisierungscode.")

    # SEC-09: read first, POP only on a match — a cross-site GET with a wrong
    # state must not be able to destroy the victim's pending connect flow.
    expected = request.session.get(_STATE_KEY)
    pending = request.session.get(_PENDING_KEY) or {}
    if not expected or state != expected:
        # CSRF guard: the old PoC never checked this.
        raise HTTPException(
            status_code=400,
            detail="Der OAuth-state passt nicht — starte das Verbinden neu.",
        )
    if pending.get("provider") != provider_id:
        raise HTTPException(
            status_code=400, detail="OAuth-Ablauf und Dienst passen nicht zusammen."
        )
    request.session.pop(_STATE_KEY, None)
    request.session.pop(_PENDING_KEY, None)

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
    try:
        provider = get_provider(provider_id)
    except KeyError as exc:
        # SEC-13: an unknown service is a 404, not an unhandled KeyError 500.
        raise HTTPException(
            status_code=404, detail=f"Unbekannter Dienst {provider_id}."
        ) from exc
    if provider.capabilities.auth not in (AuthKind.BROWSER_SDK, AuthKind.PASTED):
        raise HTTPException(
            status_code=400,
            detail="Dieser Dienst verbindet sich über eine Weiterleitung.",
        )

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
    """Disconnect ein service — F10 (ADR-003), dreistufig.

    Sofort: Tokens/Account, rohe Beobachtungen, Command-Payloads.  Binnen
    5 Tagen (``deletion_requests``-Job): alle Provider-Inhalte; der
    Hörfortschritt bleibt anonymisiert erhalten, damit ein Reconnect
    fortsetzen kann.  Body ``{"full": true}`` löscht stattdessen alles,
    ``{"immediate": true}`` zieht die Stufe 2 sofort vor (kein Export mehr
    möglich — die Frist ist eine Obergrenze, kein Mindestalter).
    """
    from app import retention

    user_id = await require_user_id(request)
    # SEC-12: validate the service and require something to disconnect —
    # deletion_requests is the provable compliance ledger (ADR-003 F10) and
    # must not be spammable with fantasy providers or no-op rows.
    try:
        get_provider(provider_id)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=f"Unbekannter Dienst {provider_id}."
        ) from exc
    try:
        account = await db.get_provider_account(user_id, provider_id)
    except VaultError:
        account = True  # unlesbarer Blob (SEC-07): erst recht löschen
    if account is None:
        raise HTTPException(
            status_code=404, detail="Hier ist nichts verbunden."
        )
    try:
        body = await request.json()
    except Exception:
        body = {}
    full = bool(body.get("full"))
    outcome = await retention.schedule_provider_deletion(
        user_id, provider_id, full=full
    )
    if body.get("immediate"):
        await retention.run_due_deletions(include_not_due=True)
        outcome["executed"] = "immediate"
    return JSONResponse({
        "status": "disconnected", "provider": provider_id, **outcome,
    })


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
