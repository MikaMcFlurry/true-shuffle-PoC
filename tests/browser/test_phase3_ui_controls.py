"""WP4 — the three UI controls added on top of the D1-D3 backends:

* UC-21: the player's "Ausgeschlossene Titel" disclosure — exclude a track
  from "Als Nächstes", find it in the reactivation list, take it back.
* UC-08: the builder's Favoriten-Vorrang radios now really write
  ``favorite_weight`` into the saved configuration.
* UC-07: the per-row "Gewicht" cycle button in "Als Nächstes" really PUTs
  the chosen weight.

Same fixture patterns as ``test_phase3_flows.py`` (``tests/browser/conftest.py``
/ ``tests/browser/helpers.py``): a real uvicorn, a real Chromium, the demo
connector. Every assertion is a product claim, not an implementation detail.
"""

from __future__ import annotations

import uuid

import pytest

from tests.browser import helpers

pytestmark = pytest.mark.browser


# ---------------------------------------------------------------------------
# (a) UC-21/UC-20: exclude a track → it shows up in "Ausgeschlossene Titel"
#     → "Wieder aufnehmen" → back in "Als Nächstes".
# ---------------------------------------------------------------------------

def test_excluding_then_reactivating_a_track_returns_it_to_up_next(page):
    run_id = helpers.start_live_run(page, helpers.DEMO_PLAYLIST_SMALL)

    # "Als Nächstes" only ever shows an 8-row window (app/runs.py describe()).
    # The 12-track small demo playlist has more than 8 candidates left right
    # after dealing, so a reactivated track could land past the visible
    # window purely by the shuffle's luck. Advancing first shrinks the tail
    # under 8 candidates, so everything that is still in the run is
    # guaranteed visible — the reappearance check below is deterministic,
    # not a coin flip.
    for _ in range(4):
        page.evaluate(
            "([id]) => fetch(`/api/runs/${id}/advance`, {"
            "method: 'POST', headers: {'Content-Type': 'application/json'}, "
            "body: JSON.stringify({reason: 'user_skip'})})",
            [run_id],
        )
        page.wait_for_timeout(120)
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#upnext li .u-name")

    first_row = page.locator("#upnext li").first
    excluded_name = first_row.locator(".u-name").inner_text()
    exclude_btn = first_row.locator('button[aria-label^="Titel ausschließen"]')
    assert exclude_btn.count() == 1, "the exclude icon is missing from the up-next row"
    exclude_btn.click()

    page.wait_for_function(
        "() => (document.querySelector('#playerNote')?.textContent || '')"
        ".toLowerCase().includes('ausgeschlossen')",
        timeout=10_000,
    )
    remaining = page.locator("#upnext li .u-name").all_inner_texts()
    assert excluded_name not in remaining, (
        f"„{excluded_name}“ excluded but still listed in Als Nächstes: {remaining}"
    )

    # The disclosure is a real <button> with an explicit aria-expanded this
    # page owns (not <details>'s implicit state) — starts collapsed.
    toggle = page.locator("#excludedToggle")
    assert toggle.get_attribute("aria-expanded") == "false"
    toggle.click()
    assert toggle.get_attribute("aria-expanded") == "true"

    page.wait_for_function(
        "([n]) => [...document.querySelectorAll('#excludedList .u-name')]"
        ".some((e) => e.textContent.trim() === n)",
        arg=[excluded_name],
        timeout=10_000,
    )
    row = page.locator("#excludedList li.excluded-row")
    assert row.count() == 1, "expected exactly one excluded row"
    assert excluded_name in row.inner_text()

    reactivate_btn = row.locator("button", has_text="Wieder aufnehmen")
    assert reactivate_btn.count() == 1
    reactivate_btn.click()

    page.wait_for_function(
        "() => (document.querySelector('#playerNote')?.textContent || '')"
        ".toLowerCase().includes('wieder aufgenommen')",
        timeout=10_000,
    )
    # Back in "Als Nächstes" ...
    page.wait_for_function(
        "([n]) => [...document.querySelectorAll('#upnext .u-name')]"
        ".some((e) => e.textContent.trim() === n)",
        arg=[excluded_name],
        timeout=10_000,
    )
    # ... and the disclosure now shows its honest empty state.
    page.wait_for_function(
        "() => (document.querySelector('#excludedList')?.textContent || '')"
        ".includes('Keine ausgeschlossenen Titel')",
        timeout=10_000,
    )
    # Focus lands somewhere still meaningful, not silently dropped to <body>.
    assert page.evaluate("() => document.activeElement.id") == "excludedToggle"


def test_import_excluded_tracks_have_no_reactivate_button(page):
    """``excluded_rule`` rows (import-time) are shown, never offered a button."""
    run_id = helpers.deal_live_run(page, helpers.DEMO_PLAYLIST_DIRTY)
    page.click("#excludedToggle")

    rule_excluded = page.evaluate(
        "([id]) => fetch(`/api/runs/${id}/tracks?state=excluded`)"
        ".then((r) => r.json())"
        ".then((b) => b.tracks.filter((t) => t.state === 'excluded_rule').length)",
        [run_id],
    )
    if rule_excluded == 0:
        pytest.skip("the dirty demo playlist produced no excluded_rule row this time")

    page.wait_for_function(
        "() => (document.querySelector('#excludedList')?.textContent || '').trim().length > 0",
        timeout=10_000,
    )
    rows = page.locator("#excludedList li.excluded-row")
    assert rows.count() >= 1
    reasons = page.locator("#excludedList .excluded-reason").all_inner_texts()
    assert any("nicht wieder aufnehmbar" in r for r in reasons)
    # None of those rows offer a clickable "Wieder aufnehmen" — never a fake
    # affordance for an action the server would 409 on.
    for i in range(rows.count()):
        row_text = rows.nth(i).inner_text()
        if "nicht wieder aufnehmbar" in row_text:
            assert rows.nth(i).locator("button", has_text="Wieder aufnehmen").count() == 0


# ---------------------------------------------------------------------------
# (b) UC-08: Favoriten-Vorrang "Stark" in the builder → Konfiguration
#     speichern → favorite_weight == 4.0 via the API.
# ---------------------------------------------------------------------------

def test_builder_favorite_weight_strong_saves_as_four(page):
    page.goto("/library", wait_until="networkidle")
    helpers.release_playing_slot(page)
    page.wait_for_selector("button.record")
    page.click('#modeCards button:has-text("Live")')
    page.click(f'button.record:has-text("{helpers.DEMO_PLAYLIST_SMALL}")')
    page.select_option("#reshuffle", "1")

    assert page.eval_on_selector("#r-fav-off", "(e) => e.checked") is True
    # The rule group is a collapsed <details> by default (only "Wiederholungs-
    # modus" starts open) — open it before the radio inside becomes clickable.
    page.click('summary:has-text("Favoriten-Vorrang")')
    page.check("#r-fav-strong")
    page.wait_for_function(
        "document.querySelector('#favoritenState')?.textContent.includes('Stark')",
        timeout=5_000,
    )

    config_name = f"Browser-Test Favoriten {uuid.uuid4().hex[:8]}"
    page.fill("#configSaveName", config_name)
    page.click("#saveConfigBtn")
    page.wait_for_function(
        "([n]) => (document.querySelector('#saveConfigNote')?.textContent || '').includes(n)",
        arg=[config_name],
        timeout=10_000,
    )

    configs = page.evaluate("() => fetch('/api/configs').then((r) => r.json())")["configs"]
    saved = next(c for c in configs if c["name"] == config_name)
    assert saved["rules"]["favorite_weight"] == 4.0, saved["rules"]

    # Loading that same config back re-checks the matching radio stage.
    page.reload(wait_until="networkidle")
    page.wait_for_function(
        "([id]) => [...document.querySelectorAll('#configPicker option')]"
        ".some((o) => o.value === String(id))",
        arg=[saved["id"]],
        timeout=10_000,
    )
    page.select_option("#configPicker", str(saved["id"]))
    page.wait_for_function(
        "() => document.querySelector('#r-fav-strong')?.checked === true", timeout=5_000
    )
    assert page.eval_on_selector("#r-fav-strong", "(e) => e.disabled") is True, (
        "picking a saved config should lock the rule inputs to read-only"
    )


# ---------------------------------------------------------------------------
# (c) UC-07: the "Gewicht" cycle button in "Als Nächstes" → PUT weight 2.0,
#     the row's own control reflects "Öfter".
# ---------------------------------------------------------------------------

def test_upnext_weight_control_cycles_to_more_and_persists(page):
    run_id = helpers.start_live_run(page, helpers.DEMO_PLAYLIST_SMALL)
    page.wait_for_selector("#upnext li .u-name")

    first_row = page.locator("#upnext li").first
    track_name = first_row.locator(".u-name").inner_text()
    weight_btn = first_row.locator('button[aria-label^="Gewicht für"]')
    assert weight_btn.count() == 1, "the UC-07 weight control is missing from the up-next row"
    assert "Normal" in weight_btn.get_attribute("aria-label"), (
        "a freshly dealt run should start every card at weight 1.0 (Normal)"
    )

    weight_btn.click()
    page.wait_for_function(
        "() => document.querySelector('#upnext li button[aria-label^=\"Gewicht für\"]')"
        "?.getAttribute('aria-label').includes('Öfter')",
        timeout=10_000,
    )

    state = page.evaluate(
        "([id]) => fetch(`/api/runs/${id}`).then((r) => r.json())", [run_id]
    )
    entries = ([state["current"]] if state.get("current") else []) + list(state.get("upcoming", []))
    match = next((e for e in entries if e.get("name") == track_name), None)
    assert match is not None, f"track {track_name!r} not found in the run state: {entries}"
    assert match["weight"] == 2.0, (
        f"expected weight 2.0 (Öfter) after one click, got {match['weight']}"
    )

    # One more click cycles onward to "Selten" (0.4) — the third stage exists
    # and the control keeps its accessible name in sync with the server.
    page.locator("#upnext li").first.locator(
        'button[aria-label^="Gewicht für"]'
    ).click()
    page.wait_for_function(
        "() => document.querySelector('#upnext li button[aria-label^=\"Gewicht für\"]')"
        "?.getAttribute('aria-label').includes('Selten')",
        timeout=10_000,
    )
    state = page.evaluate(
        "([id]) => fetch(`/api/runs/${id}`).then((r) => r.json())", [run_id]
    )
    entries = ([state["current"]] if state.get("current") else []) + list(state.get("upcoming", []))
    match = next((e for e in entries if e.get("name") == track_name), None)
    assert match is not None
    assert match["weight"] == 0.4, (
        f"expected weight 0.4 (Selten) after the second click, got {match['weight']}"
    )
