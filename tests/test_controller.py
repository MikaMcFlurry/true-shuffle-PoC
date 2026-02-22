"""Tests for Controller Mode routes (app/routes_controller.py)."""

from __future__ import annotations


import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes_controller import _persist_cursor, _complete_run


@pytest.fixture(autouse=True)
def _use_tmp_db(monkeypatch, tmp_path):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_cid")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()


client = TestClient(app)


# ---------------------------------------------------------------------------
# Auth guard tests
# ---------------------------------------------------------------------------

def test_controller_start_requires_login():
    """Should return 401 if not logged in."""
    resp = client.post("/controller/start", data={"playlist_id": "test"})
    assert resp.status_code == 401


def test_controller_next_requires_login():
    """Should return 401 if not logged in."""
    resp = client.post(
        "/controller/next",
        json={"run_id": 1},
    )
    assert resp.status_code == 401


def test_controller_stop_requires_login():
    """Should return 401 if not logged in."""
    resp = client.post(
        "/controller/stop",
        json={"run_id": 1},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Helper tests (need DB)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_persist_cursor(tmp_path, monkeypatch):
    """_persist_cursor should update the cursor field in the DB."""
    from app.db import init_db, close_db, get_db
    monkeypatch.setenv("DB_PATH", str(tmp_path / "ctrl.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    await init_db()
    db = get_db()

    # Insert test user + run
    await db.execute(
        "INSERT INTO users (spotify_user_id, display_name) VALUES ('u1', 'Test')"
    )
    await db.execute(
        """
        INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, status)
        VALUES (1, 'p1', 'controller', '["a","b","c"]', 0, 'active')
        """
    )
    await db.commit()

    await _persist_cursor(1, 2)

    c = await db.execute("SELECT cursor FROM runs WHERE id = 1")
    row = await c.fetchone()
    assert row[0] == 2

    await close_db()


@pytest.mark.asyncio
async def test_complete_run(tmp_path, monkeypatch):
    """_complete_run should set status to 'completed'."""
    from app.db import init_db, close_db, get_db
    monkeypatch.setenv("DB_PATH", str(tmp_path / "ctrl2.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    await init_db()
    db = get_db()

    await db.execute(
        "INSERT INTO users (spotify_user_id, display_name) VALUES ('u1', 'Test')"
    )
    await db.execute(
        """
        INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, status)
        VALUES (1, 'p1', 'controller', '["a","b"]', 0, 'active')
        """
    )
    await db.commit()

    await _complete_run(1)

    c = await db.execute("SELECT status FROM runs WHERE id = 1")
    row = await c.fetchone()
    assert row[0] == "completed"

    await close_db()
