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

    yield

    retention_task.cancel()
    with contextlib.suppress(BaseException):
        await retention_task
    await watcher.stop_all()
    await jobs.cancel_all()
    await close_db()
    logger.info("shutdown complete")


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
