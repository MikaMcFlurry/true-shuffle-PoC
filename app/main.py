"""FastAPI application entry point."""

from __future__ import annotations

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
from app.routes_api import router as api_router
from app.routes_auth import router as auth_router
from app.routes_export import router as export_router
from app.routes_pages import router as pages_router
from app.watcher import watcher
from providers.base import ProviderError

logger = logging.getLogger("true_shuffle")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle hook."""
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))

    await init_db()
    logger.info("database ready at %s", settings.db_abs_path)
    for warning in settings.insecure_defaults():
        logger.warning("%s", warning)

    yield

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

app.add_middleware(
    SessionMiddleware,
    secret_key=get_settings().secret_key,
    same_site="lax",
    https_only=get_settings().base_url.startswith("https://"),
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

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
