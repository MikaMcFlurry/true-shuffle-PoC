"""FastAPI application entry point."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from app import jobs
from app.config import get_settings
from app.db import close_db, init_db
from app.gate import register as register_gate
from app.routes_api import router as api_router
from app.routes_auth import router as auth_router
from app.routes_export import router as export_router
from app.routes_pages import router as pages_router
from app.watcher import watcher
from core.engine import RunError
from providers.base import ProviderError

logger = logging.getLogger("true_shuffle")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle hook."""
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))

    # SEC-01 (fail closed): a default SECRET_KEY on anything but pure local
    # use makes session forgery and a gate bypass trivial — refuse to boot.
    refusal = settings.refuse_to_start_reason()
    if refusal:
        raise RuntimeError(refusal)
    # SEC-14: at DEBUG, aiosqlite logs every statement WITH bound parameters
    # (token blobs, account names) — pin it to INFO whatever LOG_LEVEL says.
    logging.getLogger("aiosqlite").setLevel(logging.INFO)

    await init_db()
    logger.info("database ready at %s", settings.db_abs_path)
    for warning in settings.insecure_defaults():
        logger.warning("%s", warning)

    # F10 (ADR-003): fällige Löschanträge beim Start und dann täglich —
    # die 5-Tage-Frist muss auch nach einem Neustart nachweisbar halten.
    from app import retention

    async def _retention_tick():
        while True:
            try:
                outcomes = await retention.run_due_deletions()
                if outcomes:
                    logger.info("retention: %s request(s) processed", len(outcomes))
            except Exception:
                logger.exception("retention tick failed")
            await asyncio.sleep(24 * 3600)

    retention_task = asyncio.create_task(_retention_tick(), name="ts-retention")

    # ADR-005: an ACTIVE run with no watcher is a deck that silently stopped
    # moving.  Until now watchers were only ever armed from three request
    # handlers, so a redeploy or a crashed task left runs stranded and the only
    # way back was pressing start.  Re-arm at boot, then keep checking.
    #
    # Deliberately NOT awaited here.  Both steps do serial network I/O — a
    # token refresh per user, an unfollow per orphaned playlist — and awaiting
    # them would put Spotify's availability in the startup path: a 429 or a
    # 5xx from the token endpoint would keep the process from ever serving a
    # request.  Boot must not depend on a third party being up.
    async def _boot_recovery():
        try:
            await watcher.ensure_all()
        except Exception:
            logger.exception("watcher rehydration failed")
        try:
            await _sweep_orphaned_contexts()
        except Exception:
            logger.exception("orphaned-context sweep failed")

    async def _watcher_supervisor():
        interval = max(10.0, settings.watcher_supervisor_seconds)
        while True:
            await asyncio.sleep(interval)
            try:
                await watcher.ensure_all()
            except Exception:
                logger.exception("watcher supervisor tick failed")

    boot_task = asyncio.create_task(_boot_recovery(), name="ts-boot-recovery")
    supervisor_task = asyncio.create_task(
        _watcher_supervisor(), name="ts-watcher-supervisor"
    )

    yield

    boot_task.cancel()
    supervisor_task.cancel()
    with contextlib.suppress(BaseException):
        await boot_task
    with contextlib.suppress(BaseException):
        await supervisor_task
    # Let in-flight helper-playlist fills finish (or fail) rather than being
    # abandoned mid-write.
    from app import execution as _execution
    with contextlib.suppress(BaseException):
        await asyncio.wait_for(_execution.drain_fill_tasks(), timeout=5.0)
    retention_task.cancel()
    with contextlib.suppress(BaseException):
        await retention_task
    await watcher.stop_all()
    await jobs.cancel_all()
    await close_db()
    logger.info("shutdown complete")


async def _sweep_orphaned_contexts() -> None:
    """Remove helper playlists whose run is over (ADR-005).

    The context-playlist strategy writes into the listener's Spotify account.
    A crash between "playlist created" and "run finished" leaves one of ours
    sitting in their library with nothing pointing at it — litter we made, so
    litter we clear.  Best effort: a listener who disconnected is beyond our
    reach, and the ledger says so rather than pretending otherwise.
    """
    from app import db as _db
    from app import execution
    from app.accounts import try_open_session

    try:
        rows = await _db.orphaned_contexts()
    except Exception:  # pragma: no cover — never break startup
        logger.exception("orphaned-context sweep: could not list contexts")
        return
    by_run: dict = {}
    for row in rows:
        by_run.setdefault((int(row["run_id"]), int(row["user_id"]),
                           str(row["provider"])), []).append(row)
    for (run_id, user_id, provider) in by_run:
        # try_open_session only swallows "not connected"; a token refresh can
        # still raise ProviderError on a 429 or an outage, and cleaning up
        # litter must never be the reason anything else fails.
        with contextlib.suppress(Exception):
            session = await try_open_session(user_id, provider)
            stuck = await execution.cleanup_contexts(session, run_id)
            if stuck:
                logger.warning(
                    "run %s: helper playlists left in the account: %s",
                    run_id, stuck,
                )


app = FastAPI(
    title="true-shuffle",
    description=(
        "Plays a playlist like a deck of cards: every playable unique track "
        "exactly once per run, across Spotify, Apple Music and YouTube Music."
    ),
    version="0.2.0",
    lifespan=lifespan,
)

# SEC-16: baseline security headers on every response — cheap second line of
# defence for the two provider-controlled URL sinks (artwork, copy link).
@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


# Order matters and reads backwards: Starlette makes the LAST middleware added
# the OUTERMOST one. The gate reads request.session, so SessionMiddleware has
# to wrap it — which means the gate is registered first.
register_gate(app)

app.add_middleware(
    SessionMiddleware,
    secret_key=get_settings().secret_key,
    same_site="lax",
    https_only=get_settings().base_url.startswith("https://"),
)

class _CachedStatic(StaticFiles):
    """Let the browser keep the fonts.

    Without this the three woff2 files (65.6 KiB) are revalidated on every
    navigation. They are content-addressed by name and change only when the
    build does, so a week is safe; everything else gets a short cache with
    revalidation so a CSS edit is picked up on reload during development.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        path = str(getattr(response, "path", ""))
        response.headers["Cache-Control"] = (
            "public, max-age=604800, immutable" if "/fonts/" in path
            else "public, max-age=0, must-revalidate"
        )
        return response


app.mount("/static", _CachedStatic(directory="app/static"), name="static")

app.include_router(pages_router)
app.include_router(auth_router)
app.include_router(api_router)
app.include_router(export_router)

_templates = Jinja2Templates(directory="app/templates")


@app.exception_handler(ProviderError)
async def provider_error_handler(request: Request, exc: ProviderError):
    """Never leak a connector stack trace to the browser."""
    status = getattr(exc, "status_code", 502)
    if request.url.path.startswith(("/api/", "/export/")):
        return JSONResponse({"detail": str(exc)}, status_code=status)
    return _templates.TemplateResponse(
        request, "error.html", {"status": status, "detail": str(exc)},
        status_code=status,
    )


@app.exception_handler(RunError)
async def run_error_handler(request: Request, exc: RunError):
    """A move that is illegal for the run's state is a 409, not a crash.

    Every one of these is reachable from a click — a finished deck's transport,
    a cancelled run's resume — so leaving it unmapped turned a legitimate press
    into a bare "Internal Server Error" in the listener's own language.
    """
    if request.url.path.startswith(("/api/", "/export/")):
        return JSONResponse({"detail": str(exc)}, status_code=409)
    return _templates.TemplateResponse(
        request, "error.html", {"status": 409, "detail": str(exc)}, status_code=409,
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if request.url.path.startswith(("/api/", "/export/")):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return _templates.TemplateResponse(
        request, "error.html", {"status": exc.status_code, "detail": exc.detail},
        status_code=exc.status_code,
    )


@app.get("/health")
async def health():
    """Simple health-check endpoint."""
    return JSONResponse({"status": "ok", "version": app.version})
