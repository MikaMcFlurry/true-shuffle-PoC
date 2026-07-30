"""The shared access code.

README says this app has no login and should not be exposed to the internet.
Deploying it so two other people can test contradicts that, so the gate exists
to make the deployed case safe. These tests pin the two things that make it
worth having: it is OFF unless configured, and a wrong code cannot be
distinguished from a right one by timing.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

CODE = "plattenschrank-2026"


@pytest.fixture
def open_client():
    """No ACCESS_CODE: exactly how local development runs."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def gated(monkeypatch):
    monkeypatch.setenv("ACCESS_CODE", CODE)
    from app.config import get_settings
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_without_a_code_configured_nothing_is_gated(open_client):
    assert open_client.get("/").status_code == 200
    assert open_client.get("/connect", follow_redirects=False).status_code == 200


def test_a_gated_server_shows_the_door_instead_of_the_app(gated):
    response = gated.get("/", follow_redirects=False)
    assert response.status_code == 200
    assert "Geschlossene Beta" in response.text
    # The app itself must not leak through the door.
    assert "Deine Playlist als Fach" not in response.text


def test_the_health_check_stays_open(gated):
    """Gating it would make every deploy look dead to the platform."""
    assert gated.get("/health").status_code == 200


def test_the_stylesheet_stays_open_or_the_door_is_unstyled(gated):
    assert gated.get("/static/style.css").status_code == 200


def test_a_wrong_code_is_refused_with_401(gated):
    response = gated.post("/zugang", data={"code": "falsch"})
    assert response.status_code == 401
    assert "stimmt nicht" in response.text


def test_the_right_code_opens_it_for_the_rest_of_the_session(gated):
    response = gated.post("/zugang", data={"code": CODE}, follow_redirects=False)
    assert response.status_code == 303
    assert gated.get("/").status_code == 200
    assert "Deine Playlist als Fach" in gated.get("/").text


def test_an_api_call_behind_the_gate_gets_json_not_a_login_page(gated):
    """fetch() cannot render HTML; it would report a confusing parse error."""
    response = gated.get("/api/runs")
    assert response.status_code == 401
    assert response.json()["detail"].startswith("Zugangscode")


def test_the_code_is_compared_in_constant_time():
    """A plain == leaks the code one character at a time from timings."""
    import inspect

    from app import gate
    assert "compare_digest" in inspect.getsource(gate)
    assert "secrets" in inspect.getsource(gate)
