"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

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

# Session middleware (signed cookie — stores PKCE verifier + user id).
app.add_middleware(SessionMiddleware, secret_key=get_settings().secret_key)

# Static files
from fastapi.staticfiles import StaticFiles  # noqa: E402

app.mount("/static", StaticFiles(directory="app/static"), name="static")

# Routers
from app.auth import router as auth_router  # noqa: E402
from app.routes_utility import router as utility_router  # noqa: E402

app.include_router(auth_router)
app.include_router(utility_router)


@app.get("/health")
async def health():
    """Simple health-check endpoint."""
    return JSONResponse({"status": "ok", "version": app.version})

