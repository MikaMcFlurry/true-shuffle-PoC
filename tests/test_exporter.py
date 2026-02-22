"""Tests for export/import (core/exporter.py and app/routes_export.py)."""

from __future__ import annotations

import json

import pytest

from core.exporter import export_run, import_run


# ---------------------------------------------------------------------------
# Core exporter logic
# ---------------------------------------------------------------------------

class TestExportRun:
    def test_export_is_valid_json(self):
        result = export_run("pid", "utility", ["uri:a", "uri:b"], 1, "active")
        data = json.loads(result)
        assert data["playlist_id"] == "pid"
        assert data["mode"] == "utility"
        assert data["shuffled_order"] == ["uri:a", "uri:b"]
        assert data["cursor"] == 1
        assert data["status"] == "active"
        assert "exported_at" in data

    def test_export_never_contains_tokens(self):
        result = export_run("pid", "utility", [], 0, "active")
        data = json.loads(result)
        for key in ("token_data", "access_token", "refresh_token", "secret_key"):
            assert key not in data


class TestImportRun:
    def test_import_roundtrip(self):
        exported = export_run("pid", "controller", ["a", "b"], 0, "active")
        payload = import_run(exported)
        assert payload.playlist_id == "pid"
        assert payload.mode == "controller"
        assert payload.shuffled_order == ["a", "b"]

    def test_import_strips_tokens(self):
        raw = json.dumps({
            "playlist_id": "p",
            "mode": "utility",
            "shuffled_order": [],
            "cursor": 0,
            "status": "active",
            "access_token": "SHOULD_BE_STRIPPED",
            "refresh_token": "SHOULD_BE_STRIPPED",
        })
        payload = import_run(raw)
        # access_token / refresh_token should not be on the payload
        raw_dict = json.loads(payload.model_dump_json())
        assert "access_token" not in raw_dict
        assert "refresh_token" not in raw_dict

    def test_import_invalid_json_raises(self):
        with pytest.raises(ValueError, match="Invalid JSON"):
            import_run("not json")


# ---------------------------------------------------------------------------
# HTTP route tests
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _use_tmp_db(monkeypatch, tmp_path):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_cid")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()


def test_export_requires_login():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/export/1")
    assert resp.status_code == 401


def test_import_requires_login():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.post("/export/import", content=b'{}')
    assert resp.status_code == 401
