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

# UI-Erneuerung TS-FABLE-01 (ADR-001): the "Durch"/"Übergeben" distinction is
# safety-relevant honesty, not styling — a Handoff run that merely handed a
# playlist over must never claim to have been played through. It is shipped
# to the client as server-rendered data (a JSON blob the page's own script
# reads), not baked into a client-side string, so the rule stays defined —
# and testable — on the server, the same way it was before the rewrite.
RUN_STATUS_VOCAB = {
    "completed_controller": "Durch",
    "completed_utility": "Übergeben",
}


def _provider_cards() -> list[dict]:
    return [
        {
            **p.capabilities.as_dict(),
            "configured": p.is_configured(),
            "missing_config": p.missing_config(),
        }
        for p in all_providers()
    ]


def _rail(cards: list[dict], connected: int) -> dict:
    """The operating rail: what this installation actually is, right now.

    It sits under the fascia on every page, so it may only carry facts that are
    true without asking a service anything — how many connectors this server has
    credentials for, how many are connected, and the one property of the product
    that never changes: the audio is never ours.
    """
    return {
        "ready": sum(1 for c in cards if c["configured"]),
        "total": len(cards),
        "connected": connected,
    }


@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    user_id = await current_user_id(request)
    connected = await db.list_provider_accounts(user_id) if user_id else []
    cards = _provider_cards()
    return templates.TemplateResponse(
        request,
        "home.html",
        {
            "providers": cards,
            "planned": planned.as_dicts(),
            "connected": {c["provider"] for c in connected},
            "warnings": get_settings().insecure_defaults(),
            "rail": _rail(cards, len(connected)),
        },
    )


@router.get("/connect", response_class=HTMLResponse)
async def connect(request: Request):
    await ensure_session_user(request)
    user_id = await current_user_id(request)
    connected = {c["provider"]: c for c in await db.list_provider_accounts(user_id or 0)}
    cards = _provider_cards()
    return templates.TemplateResponse(
        request,
        "connect.html",
        {
            "providers": cards,
            "planned": planned.as_dicts(),
            "connected": connected,
            "rail": _rail(cards, len(connected)),
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
    cards = _provider_cards()
    return templates.TemplateResponse(
        request,
        "library.html",
        {
            "providers": cards,
            "connected": accounts,
            "rail": _rail(cards, len(accounts)),
        },
    )


@router.get("/player/{run_id}", response_class=HTMLResponse)
async def player(request: Request, run_id: int):
    run = await require_run(request, run_id)
    accounts = await db.list_provider_accounts(await current_user_id(request) or 0)
    provider = next(
        (p for p in all_providers() if p.capabilities.id == run["provider"]), None
    )
    if provider is None:
        raise HTTPException(status_code=404, detail="Diesen Dienst gibt es hier nicht mehr.")
    return templates.TemplateResponse(
        request,
        "player.html",
        {
            "run_id": run_id,
            "provider": provider.capabilities.as_dict(),
            "playlist_name": run.get("playlist_name", ""),
            "mode": run.get("mode", ""),
            "status_vocab": RUN_STATUS_VOCAB,
            "rail": _rail(_provider_cards(), len(accounts)),
        },
    )


@router.get("/runs", response_class=HTMLResponse)
async def run_history(request: Request):
    user_id = await current_user_id(request)
    if user_id is None:
        return RedirectResponse("/connect", status_code=303)
    cards = _provider_cards()
    accounts = await db.list_provider_accounts(user_id)
    return templates.TemplateResponse(
        request,
        "runs.html",
        {
            "providers": cards,
            "status_vocab": RUN_STATUS_VOCAB,
            "rail": _rail(cards, len(accounts)),
        },
    )


@router.get("/runs/{run_id}/verlauf", response_class=HTMLResponse)
async def run_events_page(request: Request, run_id: int):
    """Chronological event list for one run (UX_IMPL_SPEC.md, /runs/{id}/verlauf).

    Events themselves come from ``GET /api/runs/{id}/events`` at render time —
    this route only establishes ownership and hands the page its context.
    """
    run = await require_run(request, run_id)
    cards = _provider_cards()
    accounts = await db.list_provider_accounts(await current_user_id(request) or 0)
    return templates.TemplateResponse(
        request,
        "history.html",
        {
            "run_id": run_id,
            "playlist_name": run.get("playlist_name", ""),
            "rail": _rail(cards, len(accounts)),
        },
    )


@router.get("/konfigurationen", response_class=HTMLResponse)
async def configurations(request: Request):
    """Config Library preview — honest, no functionality it does not have.

    "Ohne Wiederholungen" is the only preset the engine runs today; every
    other card here is a declared preview (ADR-001, /library carries the
    same rule for the run builder's preset grid).
    """
    user_id = await current_user_id(request)
    cards = _provider_cards()
    accounts = await db.list_provider_accounts(user_id) if user_id else []
    return templates.TemplateResponse(
        request,
        "configs.html",
        {"rail": _rail(cards, len(accounts))},
    )


@router.get("/styleguide", response_class=HTMLResponse)
async def styleguide(request: Request):
    """Every "Nachtpult" component, both themes, all states — dev only.

    Some states (system state C, error/empty edges) are not reachable through
    the demo flow in this phase, so this page is the acceptance surface for
    them (UX_IMPL_SPEC.md, "Styleguide-Seite"). Gated the same way the demo
    connector is: there is no ``debug`` flag in Settings, so a DEBUG log level
    stands in for it.
    """
    settings = get_settings()
    if not (settings.enable_demo_provider or settings.log_level.upper() == "DEBUG"):
        raise HTTPException(
            status_code=404,
            detail="Der Styleguide ist nur mit ENABLE_DEMO_PROVIDER=true "
            "oder LOG_LEVEL=DEBUG erreichbar.",
        )
    return templates.TemplateResponse(request, "styleguide.html", {})
