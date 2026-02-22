"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import close_db, init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle hook."""
    settings = get_settings()
    await init_db()
    print(f"[startup] DB ready at {settings.db_abs_path}")
    yield
    await close_db()
    print("[shutdown] DB closed")


app = FastAPI(
    title="true-shuffle PoC",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Simple health-check endpoint."""
    return JSONResponse({"status": "ok", "version": app.version})
