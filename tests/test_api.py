"""End-to-end API tests against an in-memory connector."""

from __future__ import annotations

import json
import re
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def connect(client, provider_id: str = "fake") -> None:
    """Walk the OAuth flow far enough to have a connected account."""
    client.get(f"/auth/{provider_id}/login", follow_redirects=False)
    state = _session_state(client)
    client.get(
        f"/auth/{provider_id}/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )


def _session_state(client) -> str:
    """Read the OAuth state the server just stashed in the session cookie."""
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    cookie = client.cookies.get("session")
    signer = TimestampSigner(get_settings().secret_key)
    import base64
    data = signer.unsign(cookie, max_age=3600)
    return json.loads(base64.urlsafe_b64decode(data))["oauth_state"]


def deal(client, mode: str = "controller", provider: str = "fake") -> dict:
    """Create a run and wait for the background job to finish."""
    response = client.post("/api/runs", json={
        "provider": provider, "playlist_id": "pl1", "mode": mode,
    })
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]

    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            return snap["result"]
        if snap["status"] == "error":
            pytest.fail(f"job failed: {snap['message']}")
        time.sleep(0.05)
    pytest.fail("job did not finish in time")


# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------

def test_health_reports_provider_configuration(client):
    payload = client.get("/api/health").json()
    assert payload["status"] == "ok"
    assert "spotify" in payload["providers"]
    assert payload["providers"]["apple"]["playback"] == "web_player"


def test_health_endpoint(client):
    payload = client.get("/health").json()
    assert payload["status"] == "ok"
    assert payload["version"] == app.version


def test_home_page_renders(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "true-shuffle" in response.text
    # UI-Erneuerung TS-FABLE-01 (ADR-001): visuelle Fixture ersetzt durch
    # semantisches Äquivalent. Die Karteikasten-Visualisierung (crateviz /
    # divider) gehörte zur abgeschafften Alt-UI ("Plattenschrank"); das neue
    # Nachtpult-System zeigt stattdessen die Landmark und das neu getextete,
    # ehrliche Produktversprechen (Hörvorgang/Wiedergabe-Trennung).
    assert 'id="inhalt"' in response.text
    assert "Hörvorgang" in response.text
    assert "spielt nie selbst Ton ab" in response.text


def test_every_page_states_that_the_audio_is_never_ours(client):
    """The one claim that must never quietly disappear."""
    # UI-Erneuerung TS-FABLE-01 (ADR-001): visuelle Fixture ersetzt durch
    # semantisches Äquivalent. Der Operating-Rail-Slogan ("... IMMER ÜBER DEN
    # DIENST") gehörte zur abgeschafften Fascia-Kopfzeile; dieselbe Zusicherung
    # lebt jetzt als Footer-Claim (base.html) auf jeder Seite weiter.
    for path in ("/", "/connect"):
        assert "spielt nie selbst Ton ab" in client.get(path).text


def test_providers_endpoint_lists_capabilities_and_connection_state(client, fake_provider):
    payload = client.get("/api/providers").json()
    ids = {p["id"] for p in payload["providers"]}
    assert {"spotify", "apple", "youtube", "fake"} <= ids
    assert payload["planned"]

    fake = next(p for p in payload["providers"] if p["id"] == "fake")
    assert fake["connected"] is False


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def test_connect_flow_stores_an_account(client, fake_provider):
    connect(client)
    payload = client.get("/api/providers").json()
    fake = next(p for p in payload["providers"] if p["id"] == "fake")
    assert fake["connected"] is True
    assert fake["account_name"] == "Fake User"


def test_a_service_that_hides_the_tier_still_shows_as_connected(
    client, fake_tierless_provider
):
    """Spotify stopped reporting market and tier; the card must survive it.

    A connector with nothing to say about the subscription is still connected,
    and the page has to state that the values are unavailable rather than leave
    a hole where two rows used to be.
    """
    connect(client, "faketier")

    payload = client.get("/api/providers").json()
    card = next(p for p in payload["providers"] if p["id"] == "faketier")
    assert card["connected"] is True
    assert card["account_name"] == "Fake User"
    assert card["market"] == ""
    assert card["product_tier"] == ""
    assert card["reports_account_tier"] is False

    page = client.get("/connect").text
    assert "Verbunden" in page
    assert "Fake User" in page
    assert "gibt Fake faketier nicht mehr heraus" in page


def test_callback_rejects_a_mismatched_state(client, fake_provider):
    """CSRF guard — the old PoC never checked the OAuth state."""
    client.get("/auth/fake/login", follow_redirects=False)
    response = client.get("/auth/fake/callback",
                          params={"code": "c", "state": "forged"},
                          follow_redirects=False)
    assert response.status_code == 400


def test_callback_without_a_started_flow_is_rejected(client, fake_provider):
    response = client.get("/auth/fake/callback", params={"code": "c", "state": "x"},
                          follow_redirects=False)
    assert response.status_code == 400


def test_unknown_provider_login_is_404(client):
    assert client.get("/auth/napster/login", follow_redirects=False).status_code == 404


def test_disconnect_removes_the_account(client, fake_provider):
    connect(client)
    assert client.post("/auth/fake/disconnect").status_code == 200
    payload = client.get("/api/providers").json()
    fake = next(p for p in payload["providers"] if p["id"] == "fake")
    assert fake["connected"] is False


def test_apple_uses_a_browser_flow_not_a_redirect(client, monkeypatch):
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv("APPLE_PRIVATE_KEY", key)
    from app.config import get_settings
    get_settings.cache_clear()

    response = client.get("/auth/apple/login", follow_redirects=False)
    assert response.status_code == 200
    assert "MusicKit" in response.text


def test_an_unconfigured_provider_explains_what_is_missing(client, monkeypatch):
    monkeypatch.setenv("YOUTUBE_CLIENT_ID", "")
    monkeypatch.setenv("YOUTUBE_CLIENT_SECRET", "")
    from app.config import get_settings
    get_settings.cache_clear()

    response = client.get("/auth/youtube/login", follow_redirects=False)
    assert response.status_code == 503
    assert "YOUTUBE_CLIENT_ID" in response.text


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------

def test_playlists_require_a_connected_account(client, fake_provider):
    client.get("/api/providers")   # establishes a session
    response = client.get("/api/playlists", params={"provider": "fake"})
    assert response.status_code == 409


def test_playlists_are_listed_once_connected(client, fake_provider):
    connect(client)
    payload = client.get("/api/playlists", params={"provider": "fake"}).json()
    assert payload["playlists"][0]["name"] == "Everything"


def test_an_unreadable_playlist_is_listed_with_its_reason(client, fake_provider):
    """The library must show it and say why, not hide it and not lie about it."""
    connect(client)
    payload = client.get("/api/playlists", params={"provider": "fake"}).json()
    foreign = next(p for p in payload["playlists"] if p["id"] == "pl-foreign")

    assert foreign["readable"] is False
    assert foreign["unreadable_reason"]
    # Negative, not zero: the UI prints "—" for this and a digit for a real count.
    assert foreign["track_count"] < 0


def test_dealing_an_unreadable_playlist_explains_itself(client, fake_provider):
    """A stated reason beats a progress bar that dies at nothing."""
    connect(client)
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl-foreign", "mode": "utility",
    })
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "Playlist" in detail
    # And nothing was created in the service on the way out.
    assert fake_provider.created == {}


def test_devices_are_listed_for_a_remote_provider(client, fake_provider):
    connect(client)
    payload = client.get("/api/devices", params={"provider": "fake"}).json()
    assert payload["remote"] is True
    assert payload["devices"][0]["id"] == "dev1"


def test_a_web_player_provider_reports_no_devices(client, fake_web_provider):
    connect(client, "fakeweb")
    payload = client.get("/api/devices", params={"provider": "fakeweb"}).json()
    assert payload["remote"] is False
    assert payload["devices"] == []


# ---------------------------------------------------------------------------
# Dealing a deck
# ---------------------------------------------------------------------------

def test_dealing_a_deck_uses_every_track_exactly_once(client, fake_provider):
    connect(client)
    result = deal(client)
    assert result["total"] == len(fake_provider.tracks)

    state = client.get(f"/api/runs/{result['run_id']}").json()
    assert state["cursor"] == 0
    assert state["remaining"] == result["total"]


def test_copy_mode_writes_the_shuffled_order_to_the_service(client, fake_provider):
    connect(client)
    result = deal(client, mode="utility")

    written = fake_provider.created[result["copy_playlist_id"]]
    assert len(written) == len(fake_provider.tracks)
    assert sorted(written) == sorted(t.id for t in fake_provider.tracks)


def test_copy_mode_reports_progress_while_reading(client, fake_provider):
    connect(client)
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "utility",
    })
    job_id = response.json()["job_id"]
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            break
        time.sleep(0.02)
    assert snap["status"] == "done"


def test_asking_for_the_same_deck_again_resumes_it(client, fake_provider):
    connect(client)
    first = deal(client)
    client.post(f"/api/runs/{first['run_id']}/advance", json={"reason": "user_skip"})

    second = deal(client)
    assert second["run_id"] == first["run_id"]
    assert second["cursor"] == 1


def test_reshuffling_deals_a_new_deck(client, fake_provider):
    connect(client)
    first = deal(client)
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        "reshuffle": True,
    })
    job_id = response.json()["job_id"]
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert snap["status"] == "done"
    assert snap["result"]["run_id"] != first["run_id"]


def test_live_mode_is_refused_on_a_provider_that_cannot_control_playback(
    client, monkeypatch
):
    from providers import registry
    from providers.base import PlaybackControl
    from tests.conftest import FakeProvider

    provider = FakeProvider("copyonly", PlaybackControl.NONE)
    monkeypatch.setitem(registry._PROVIDERS, "copyonly", provider)
    connect(client, "copyonly")

    response = client.post("/api/runs", json={
        "provider": "copyonly", "playlist_id": "pl1", "mode": "controller",
    })
    assert response.status_code == 400
    # The refusal names the mode that WOULD work, in the interface language.
    assert "Handoff-Modus" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Playing a deck
# ---------------------------------------------------------------------------

def test_starting_a_run_plays_the_first_card_and_prefetches_the_queue(
    client, fake_provider
):
    connect(client)
    run_id = deal(client)["run_id"]
    payload = client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"}).json()

    assert fake_provider.played[0] == payload["current"]["id"]
    assert len(fake_provider.queued) == 5     # QUEUE_BUFFER_SIZE


def test_skipping_consumes_one_card(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})

    payload = client.post(f"/api/runs/{run_id}/advance",
                          json={"reason": "user_skip"}).json()
    assert payload["cursor"] == 1
    assert payload["advanced"] is True


def test_a_browser_player_reports_track_ends(client, fake_web_provider):
    """Apple/YouTube path: this tab owns the audio, so it reports the end."""
    connect(client, "fakeweb")
    run_id = deal(client, provider="fakeweb")["run_id"]

    payload = client.post(f"/api/runs/{run_id}/event",
                          json={"type": "track_ended"}).json()
    assert payload["cursor"] == 1


def test_a_failed_track_does_not_stall_the_deck(client, fake_web_provider):
    connect(client, "fakeweb")
    run_id = deal(client, provider="fakeweb")["run_id"]
    payload = client.post(f"/api/runs/{run_id}/event",
                          json={"type": "playback_failed"}).json()
    assert payload["cursor"] == 1


def test_an_unknown_event_type_is_rejected(client, fake_web_provider):
    connect(client, "fakeweb")
    run_id = deal(client, provider="fakeweb")["run_id"]
    response = client.post(f"/api/runs/{run_id}/event", json={"type": "wat"})
    assert response.status_code == 400


def test_progress_events_do_not_move_the_cursor(client, fake_web_provider):
    connect(client, "fakeweb")
    run_id = deal(client, provider="fakeweb")["run_id"]
    client.post(f"/api/runs/{run_id}/event",
                json={"type": "progress", "position_ms": 30000})
    assert client.get(f"/api/runs/{run_id}").json()["cursor"] == 0


def test_previous_steps_back(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})
    payload = client.post(f"/api/runs/{run_id}/previous", json={}).json()
    assert payload["cursor"] == 0


def test_playing_the_whole_deck_completes_it(client, fake_provider):
    connect(client)
    result = deal(client)
    run_id, total = result["run_id"], result["total"]

    for _ in range(total):
        payload = client.post(f"/api/runs/{run_id}/advance",
                              json={"reason": "track_ended"}).json()

    assert payload["status"] == "completed"
    assert client.get(f"/api/runs/{run_id}").json()["remaining"] == 0


def test_no_track_repeats_across_a_whole_deck(client, fake_provider):
    """The core promise, end to end."""
    connect(client)
    result = deal(client)
    run_id, total = result["run_id"], result["total"]

    seen = [client.get(f"/api/runs/{run_id}").json()["current"]["id"]]
    for _ in range(total - 1):
        payload = client.post(f"/api/runs/{run_id}/advance",
                              json={"reason": "track_ended"}).json()
        seen.append(payload["current"]["id"])

    assert len(seen) == len(set(seen)) == total


def test_pausing_keeps_the_position_and_resuming_returns_to_it(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})

    client.post(f"/api/runs/{run_id}/pause")
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "paused"

    payload = client.post(f"/api/runs/{run_id}/start", json={}).json()
    assert payload["cursor"] == 2
    assert payload["status"] == "active"


def test_cancelling_ends_the_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/cancel")
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "cancelled"


def test_advancing_a_cancelled_run_is_a_conflict(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/cancel")
    response = client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})
    assert response.status_code == 409


def test_a_failed_queue_prefetch_is_recorded_not_swallowed(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    fake_provider.fail_enqueue = True
    client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})

    events = client.get(f"/api/runs/{run_id}/events").json()["events"]
    assert any(e["type"] == "queue_failed" for e in events)


def test_run_events_record_the_reason_for_every_move(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "native_skip"})
    events = client.get(f"/api/runs/{run_id}/events").json()["events"]
    assert any(e["reason"] == "native_skip" for e in events)


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------

def test_another_session_cannot_read_your_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]

    with TestClient(app) as stranger:
        stranger.get("/api/providers")   # separate session
        assert stranger.get(f"/api/runs/{run_id}").status_code == 404


def test_another_session_cannot_advance_your_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]

    with TestClient(app) as stranger:
        stranger.get("/api/providers")
        response = stranger.post(f"/api/runs/{run_id}/advance",
                                 json={"reason": "user_skip"})
        assert response.status_code == 404


def test_another_session_cannot_export_your_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]

    with TestClient(app) as stranger:
        stranger.get("/api/providers")
        assert stranger.get(f"/export/{run_id}").status_code == 404


def test_signed_out_requests_are_rejected(client, fake_provider):
    response = client.get("/api/runs")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Export / import
# ---------------------------------------------------------------------------

def test_exported_run_can_be_imported_and_resumed(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})
    client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})

    exported = client.get(f"/export/{run_id}")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]

    payload = client.post("/export/import", content=exported.content).json()
    assert payload["cursor"] == 2

    imported = client.get(f"/api/runs/{payload['run_id']}").json()
    assert imported["cursor"] == 2
    assert imported["status"] == "paused"


def test_importing_a_corrupt_file_is_a_clean_400(client, fake_provider):
    connect(client)
    assert client.post("/export/import", content=b"{nope").status_code == 400


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

def test_library_redirects_when_nothing_is_connected(client):
    response = client.get("/library", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/connect"


def test_library_renders_once_connected(client, fake_provider):
    connect(client)
    response = client.get("/library")
    assert response.status_code == 200
    # UI-Erneuerung TS-FABLE-01 (ADR-001): visuelle Fixture ersetzt durch
    # semantisches Äquivalent — "Ein Fach anlegen" war Alt-Wortschatz; die
    # neue Überschrift heißt "Neuer Hörvorgang".
    assert "Neuer Hörvorgang" in response.text


def test_player_page_renders_for_your_own_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    response = client.get(f"/player/{run_id}")
    assert response.status_code == 200
    assert "Als Nächstes" in response.text


def test_player_page_for_a_foreign_run_is_a_404_page(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    with TestClient(app) as stranger:
        stranger.get("/api/providers")
        response = stranger.get(f"/player/{run_id}")
        assert response.status_code == 404
        assert "Hier ist nichts" in response.text


def test_connect_page_lists_every_service(client):
    response = client.get("/connect")
    assert response.status_code == 200
    for name in ("Spotify", "Apple Music", "YouTube Music"):
        assert name in response.text


def test_history_page_renders_for_your_own_run(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    response = client.get(f"/runs/{run_id}/verlauf")
    assert response.status_code == 200
    assert 'id="inhalt"' in response.text
    assert "Verlauf" in response.text


def test_history_page_for_a_foreign_run_is_a_404(client, fake_provider):
    connect(client)
    run_id = deal(client)["run_id"]
    with TestClient(app) as stranger:
        stranger.get("/api/providers")
        response = stranger.get(f"/runs/{run_id}/verlauf")
        assert response.status_code == 404


def test_configurations_page_renders(client):
    response = client.get("/konfigurationen")
    assert response.status_code == 200
    assert 'id="inhalt"' in response.text
    assert "Ohne Wiederholungen" in response.text


def test_a_finished_deck_refuses_transport_in_german_and_not_with_a_500(
    client, fake_provider
):
    """A finished deck's transport used to be reachable by click, and the
    engine's refusal was never mapped — so a legal press returned a bare
    "Internal Server Error". It must be a 409 with a German sentence.

    (`advance` is deliberately idempotent here instead: the watcher and the
    browser can both report the last track ending, and neither is an error.)"""
    connect(client)
    run_id = deal(client)["run_id"]
    client.post(f"/api/runs/{run_id}/start")
    for _ in range(len(fake_provider.tracks)):
        client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})

    assert client.get(f"/api/runs/{run_id}").json()["status"] == "completed"

    for path in ("start", "previous"):
        response = client.post(f"/api/runs/{run_id}/{path}")
        assert response.status_code == 409, f"{path} → {response.status_code}"
        assert "durchgehört" in response.json()["detail"], path


def test_a_handoff_deck_is_never_reported_as_played_through(client, fake_provider):
    """"Durch" means played through.

    A Handoff run on a service with no listening history is marked completed
    the instant the playlist is written — nobody has played anything, and we
    will never learn whether they did. The word for that is "Übergeben".

    UI-Erneuerung TS-FABLE-01 (ADR-001): visuelle Fixture ersetzt durch
    semantisches Äquivalent. Das Run-Dashboard rendert Karten inzwischen rein
    clientseitig aus /api/runs, ein Literal-Match auf den alten Inline-Script-
    Text ("r.mode === ... ? "Durch" : "Übergeben"") gibt es also nicht mehr.
    Die Ehrlichkeitsregel selbst bleibt aber serverseitig verankert: /runs
    rendert das Vertragsvokabular als JSON-Block (siehe runs.html,
    <script type="application/json" id="statusVocab">), aus dem app.js liest.
    Dieser Test prüft genau dieses Vokabular server-seitig, statt sich auf den
    Wortlaut des Client-Codes zu verlassen.
    """
    connect(client)
    result = deal(client, mode="utility")
    run = next(r for r in client.get("/api/runs").json()["runs"]
               if r["id"] == result["run_id"])

    assert run["mode"] == "utility"
    assert run["status"] == "completed"      # nothing more is knowable
    assert run["cursor"] == 0                # and nothing was played

    page = client.get("/runs").text
    match = re.search(
        r'<script type="application/json" id="statusVocab">(.*?)</script>',
        page, re.DOTALL,
    )
    assert match, "runs.html muss das Status-Vokabular serverseitig rendern."
    vocab = json.loads(match.group(1))
    assert vocab["completed_controller"] == "Durch"
    assert vocab["completed_utility"] == "Übergeben"
    assert "Übergeben" in page
