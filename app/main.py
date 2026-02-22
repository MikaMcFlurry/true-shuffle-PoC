"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.config import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle hook."""
    settings = get_settings()
    # TODO: Ticket 2 — init DB here
    print(f"[startup] DB path: {settings.db_abs_path}")
    yield
    # shutdown cleanup (if needed)
    print("[shutdown] bye")


app = FastAPI(
    title="true-shuffle PoC",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Simple health-check endpoint."""
    return JSONResponse({"status": "ok", "version": app.version})
