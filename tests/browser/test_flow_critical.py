"""The critical path, end to end, in a real browser.

connect → library → playlist → Live-Modus → start → zone separation and
system state A → pause → resume → dashboard card with progress → history
page with events.

Every assertion here is a product claim from the work package's
"Pflicht-Screen-Set", not an implementation detail: if this test goes red the
listener can no longer tell who is driving the music.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers

pytestmark = pytest.mark.browser


def test_connect_page_shows_the_demo_service_as_connected(page):
    page.goto("/connect", wait_until="networkidle")
    body = page.inner_text("main#inhalt")
    assert "Demo-Dienst" in body
    assert "verbunden" in body.lower(), "connect page never says the service is connected"
    # The header rail is the persistent proof of the connection.
    assert page.locator(".appbar .status-pill").count() == 1


def test_library_offers_the_two_modes_and_explains_them(page):
    page.goto("/library", wait_until="networkidle")
    page.wait_for_selector("button.record")
    modes = page.locator("#modeCards button").all_inner_texts()
    assert len(modes) == 2, f"expected Live and Handoff, got {modes}"
    joined = " ".join(modes)
    assert "Live" in joined and "Handoff" in joined
    playlists = page.locator("button.record").all_inner_texts()
    assert any(helpers.DEMO_PLAYLIST_SMALL in p for p in playlists), playlists


def test_critical_flow_deal_start_pause_resume_dashboard_history(page):
    # -- deal ---------------------------------------------------------------
    run_id = helpers.deal_live_run(page)
    assert page.url.endswith(f"/player/{run_id}")

    # -- the two zones are separate, named and attributed -------------------
    playback_zone = page.locator("#zonePlayback")
    run_zone = page.locator("#zoneRun")
    assert playback_zone.count() == 1 and run_zone.count() == 1
    # text_content, not inner_text: the captions are set in small caps by CSS
    # and the assertion is about the words, not about the casing.
    playback_caption = playback_zone.locator(".zone-caption").text_content()
    run_caption = run_zone.locator(".zone-caption").text_content()
    assert "Wiedergabe" in playback_caption and "Demo-Dienst" in playback_caption
    assert "Hörvorgang" in run_caption and "True Shuffle" in run_caption
    boxes = [playback_zone.bounding_box(), run_zone.bounding_box()]
    assert all(boxes), "a zone did not render"
    # They must not be drawn as one object (ADR-001: "Run und Spotify trennen").
    assert boxes[0]["y"] + boxes[0]["height"] <= boxes[1]["y"] + 1 or \
        boxes[0]["x"] + boxes[0]["width"] <= boxes[1]["x"] + 1, \
        "playback and run zone overlap — they must be visually separate regions"

    # A dealt run is ready, not running: "Bereit ≠ Läuft".
    assert helpers.visible_state_chip(page) == "Bereit"
    assert page.locator("#contractChip").inner_text().strip() == "aktiv"

    # -- start --------------------------------------------------------------
    helpers.press_transport(page)
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    assert helpers.STATE_A_TEXT in helpers.visible_state_chip(page)
    assert page.locator("#mainBtn").get_attribute("aria-label") == "Pause"
    meter = page.locator("#runMeter")
    assert meter.get_attribute("role") == "progressbar"
    assert meter.get_attribute("aria-valuenow") is not None

    # -- pause --------------------------------------------------------------
    page.click("#mainBtn")
    page.wait_for_function(
        "() => !/Pause/.test(document.querySelector('#mainBtn').getAttribute('aria-label'))",
        timeout=15_000,
    )
    paused_label = page.locator("#mainBtn").get_attribute("aria-label")
    assert "fortsetzen" in paused_label or "starten" in paused_label, paused_label
    assert helpers.STATE_A_TEXT not in helpers.visible_state_chip(page), (
        "the page still claims True Shuffle is driving after a pause"
    )
    assert page.locator("#contractChip").inner_text().strip() == "pausiert"

    # -- resume -------------------------------------------------------------
    page.click("#mainBtn")
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    assert page.locator("#mainBtn").get_attribute("aria-label") == "Pause"

    # -- dashboard ----------------------------------------------------------
    page.goto("/runs", wait_until="networkidle")
    card = page.locator(f'[data-run-id="{run_id}"]')
    card.wait_for(timeout=15_000)
    assert helpers.DEMO_PLAYLIST_SMALL in card.locator(".run-title").inner_text()
    card_meter = card.locator(".mini-meter")
    assert card_meter.get_attribute("role") == "progressbar"
    assert card_meter.get_attribute("aria-valuenow") is not None
    assert "gespielt" in card.locator(".run-progressline").inner_text()
    page.wait_for_function(
        """([id]) => {
             const chip = document.querySelector(`[data-run-id="${id}"] [data-role="systemchip"]`);
             return chip && chip.textContent.includes('True Shuffle steuert');
           }""",
        arg=[str(run_id)],
        timeout=20_000,
    )
    assert card.locator('a:has-text("Weiterhören"), a:has-text("Öffnen")').count() >= 1

    # -- history ------------------------------------------------------------
    page.goto(f"/runs/{run_id}/verlauf", wait_until="networkidle")
    page.wait_for_selector(".event-row", timeout=15_000)
    events = page.locator(".event-row .e-type").all_inner_texts()
    assert "Hörvorgang angelegt" in events, events
    assert "Gestartet" in events, events
    assert "Pausiert" in events, events
    for row in page.locator(".event-row").all():
        assert row.locator(".e-time").inner_text().strip(), "an event has no timestamp"


def test_player_page_never_raises_a_javascript_error(page):
    run_id = helpers.start_live_run(page)
    page.goto(f"/player/{run_id}", wait_until="networkidle")
    page.wait_for_timeout(2_500)
    # Direct attribute access on purpose: the `page` fixture attaches this
    # list, and a getattr default would turn a broken fixture into a pass.
    assert not page.console_errors, f"player page logged JS errors: {page.console_errors}"
