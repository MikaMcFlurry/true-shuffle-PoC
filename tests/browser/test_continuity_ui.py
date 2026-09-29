"""Returning to a listening session must use observed state and native controls."""

import pytest

pytestmark = pytest.mark.browser


def test_watcher_liveness_is_not_a_pause_button(page, dealt_run):
    def without_observation(route):
        response = route.fetch()
        payload = response.json()
        payload["watcher"] = {"watching": True, "drifted": False, "playback": None}
        route.fulfill(response=response, json=payload)

    page.route(f"**/api/runs/{dealt_run}", without_observation)
    page.goto(f"/player/{dealt_run}", wait_until="networkidle")
    label = page.locator("#mainBtn").get_attribute("aria-label")
    assert "Pause" not in label
    page.evaluate("window.dispatchEvent(new Event('pageshow'))")
    page.wait_for_timeout(500)
    assert "Pause" not in page.locator("#mainBtn").get_attribute("aria-label")


def test_space_on_disclosure_does_not_toggle_playback(page, dealt_run):
    commands = []
    page.on("request", lambda request: commands.append(request.url)
            if request.method == "POST" and request.url.endswith(("/start", "/pause"))
            else None)
    page.goto(f"/player/{dealt_run}", wait_until="networkidle")
    toggle = page.locator("#excludedToggle")
    toggle.focus()
    toggle.press("Space")
    assert toggle.get_attribute("aria-expanded") == "true"
    assert commands == []


def test_return_to_tab_refreshes_devices(page, dealt_run):
    devices = []
    page.on("request", lambda request: devices.append(request.url)
            if "/api/devices?" in request.url else None)
    page.goto(f"/player/{dealt_run}", wait_until="networkidle")
    before = len(devices)
    page.evaluate("window.dispatchEvent(new Event('pageshow'))")
    page.wait_for_timeout(700)
    assert len(devices) > before
