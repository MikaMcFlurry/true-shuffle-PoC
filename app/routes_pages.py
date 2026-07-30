"""HTML pages.  All data loading happens client-side against ``/api``."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app import db
from app.config import get_settings
from app.deps import current_user_id, ensure_session_user, require_run
from providers import planned
from providers.registry import all_providers

router = APIRouter(tags=["pages"])
templates = Jinja2Templates(directory="app/templates")


def _provider_cards() -> list[dict]:
    return [
        {
            **p.capabilities.as_dict(),
            "configured": p.is_configured(),
            "missing_config": p.missing_config(),
        }
        for p in all_providers()
    ]


@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    user_id = await current_user_id(request)
    connected = await db.list_provider_accounts(user_id) if user_id else []
    return templates.TemplateResponse(
        request,
        "home.html",
        {
            "providers": _provider_cards(),
            "planned": planned.as_dicts(),
            "connected": {c["provider"] for c in connected},
            "warnings": get_settings().insecure_defaults(),
        },
    )


@router.get("/connect", response_class=HTMLResponse)
async def connect(request: Request):
    await ensure_session_user(request)
    user_id = await current_user_id(request)
    connected = {c["provider"]: c for c in await db.list_provider_accounts(user_id or 0)}
    return templates.TemplateResponse(
        request,
        "connect.html",
        {
            "providers": _provider_cards(),
            "planned": planned.as_dicts(),
            "connected": connected,
        },
    )


@router.get("/library", response_class=HTMLResponse)
async def library(request: Request):
    user_id = await current_user_id(request)
    if user_id is None:
        return RedirectResponse("/connect", status_code=303)
    accounts = await db.list_provider_accounts(user_id)
    if not accounts:
        return RedirectResponse("/connect", status_code=303)
    return templates.TemplateResponse(
        request,
        "library.html",
        {"providers": _provider_cards(), "connected": accounts},
    )


@router.get("/player/{run_id}", response_class=HTMLResponse)
async def player(request: Request, run_id: int):
    run = await require_run(request, run_id)
    provider = next(
        (p for p in all_providers() if p.capabilities.id == run["provider"]), None
    )
    if provider is None:
        raise HTTPException(status_code=404, detail="Provider no longer available")
    return templates.TemplateResponse(
        request,
        "player.html",
        {
            "run_id": run_id,
            "provider": provider.capabilities.as_dict(),
            "playlist_name": run.get("playlist_name", ""),
        },
    )


@router.get("/runs", response_class=HTMLResponse)
async def run_history(request: Request):
    user_id = await current_user_id(request)
    if user_id is None:
        return RedirectResponse("/connect", status_code=303)
    return templates.TemplateResponse(
        request, "runs.html", {"providers": _provider_cards()}
    )
