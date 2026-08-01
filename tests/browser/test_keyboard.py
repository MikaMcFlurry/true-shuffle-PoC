"""Keyboard operation: tab order, visible focus, skip link, transport keys.

"Mobile zuerst" does not excuse a keyboard-hostile desktop, and the work
package lists Tastaturbedienung and sichtbare Focus States as separate
acceptance items. Each of them gets its own assertion here.
"""

from __future__ import annotations

import itertools

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser


def test_first_tab_reveals_the_skip_link_and_it_jumps_to_the_content(page, dealt_run):
    page.goto("/library", wait_until="networkidle")
    page.keyboard.press("Tab")

    focused = page.evaluate(helpers.JS_ACTIVE_ELEMENT)
    assert "skip-link" in focused["cls"], f"first Tab focused {helpers.describe(focused)}"
    assert focused["href"] == "#inhalt"
    assert focused["text"] == "Zum Inhalt springen"

    # Off-screen until focused, on-screen once focused — otherwise it is a
    # skip link nobody can see. The link slides in, so give the transition
    # its declared duration before measuring where it landed.
    page.wait_for_timeout(500)
    top = page.eval_on_selector("a.skip-link", "(e) => Math.round(e.getBoundingClientRect().top)")
    assert top >= 0, f"skip link stays off-screen when focused (top={top})"
    assert page.locator("a.skip-link").is_visible()

    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    assert page.evaluate("() => document.activeElement.id") == "inhalt", (
        "Enter on the skip link did not move focus into main#inhalt"
    )
    assert page.url.endswith("#inhalt")


def test_focus_visible_draws_a_real_outline_on_every_stop(page, dealt_run):
    """Every keyboard stop shows a computed ``:focus-visible`` outline."""
    problems = []
    walked = {}
    for path in ("/library", f"/player/{dealt_run}"):
        page.goto(path, wait_until="networkidle")
        page.wait_for_timeout(600)
        stops = helpers.tab_walk(page, steps=45)
        walked[path] = [
            {
                "node": helpers.describe(stop),
                "name": stop["text"],
                "outline": " ".join(
                    (stop["outline_width"], stop["outline_style"], stop["outline_color"])
                ),
            }
            for stop in stops
        ]
        assert len(stops) >= 8, f"{path}: only {len(stops)} keyboard stops"
        for stop in stops:
            has_outline = (
                stop["outline_style"] != "none" and helpers.px(stop["outline_width"]) >= 1
            )
            if not has_outline and "none" in stop["box_shadow"]:
                problems.append(
                    f"{path}: {helpers.describe(stop)} ({stop['text']!r}) "
                    f"has no visible focus ring"
                )
    write_artifact_json("tab_order.json", walked)
    assert not problems, "focus visibility defects:\n  " + "\n  ".join(problems)


#: What the app bar must always offer first, in this order.
APPBAR_PREFIX = ["/", "/runs", "/library", "/connect", "/konfigurationen"]

#: Controls the keyboard has to be able to reach on each page.
MUST_REACH = {
    "/library": {"plFilter", "dealBtn", "reshuffle"},
    "/player": {"prevBtn", "mainBtn", "nextBtn", "cancelBtn", "deviceSelect"},
}


def test_tab_order_follows_the_source_order(page, dealt_run):
    """The complete tab walk of /library and /player, checked end to end.

    Two things are asserted, and they are the two ways a tab order actually
    breaks: the app bar must come first in its visual order, and focus must
    never move *backwards* through the document — which is what a stray
    positive ``tabindex`` would cause.
    """
    problems = []
    for path, key in (("/library", "/library"), (f"/player/{dealt_run}", "/player")):
        page.goto(path, wait_until="networkidle")
        page.wait_for_timeout(800)
        stops = helpers.tab_walk(page, steps=60)
        assert len(stops) >= 10, f"{path}: only {len(stops)} keyboard stops"

        assert "skip-link" in stops[0]["cls"], f"{path}: first stop is not the skip link"
        assert "wordmark" in stops[1]["cls"], f"{path}: second stop is not the wordmark"
        nav_hrefs = [s["href"] for s in stops[2:7]]
        assert nav_hrefs == APPBAR_PREFIX, (
            f"{path}: navigation is not tabbed in its visual order: {nav_hrefs}"
        )
        assert stops[7]["id"] == "themeToggle", f"{path}: theme toggle is not stop 8"

        for previous, current in itertools.pairwise(stops):
            if current["dom_index"] <= previous["dom_index"]:
                problems.append(
                    f"{path}: focus went backwards, {helpers.describe(previous)} "
                    f"→ {helpers.describe(current)}"
                )
            if current["tabindex"] and int(current["tabindex"]) > 0:
                problems.append(
                    f"{path}: {helpers.describe(current)} uses a positive tabindex "
                    f"({current['tabindex']})"
                )

        reached = {s["id"] for s in stops}
        missing = MUST_REACH[key] - reached
        if missing:
            problems.append(f"{path}: keyboard never reaches {sorted(missing)}")
    assert not problems, "tab order defects:\n  " + "\n  ".join(problems)


def test_transport_keys_drive_the_run(page, live_run):
    """Space starts/pauses, → skips, ← goes back — with the page focused."""
    page.goto(f"/player/{live_run}", wait_until="networkidle")
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    page.evaluate("() => document.body.focus()")

    with page.expect_request(
        lambda r: r.url.endswith(f"/api/runs/{live_run}/advance") and r.method == "POST",
        timeout=10_000,
    ):
        page.keyboard.press("ArrowRight")
    page.wait_for_timeout(400)

    with page.expect_request(
        lambda r: r.url.endswith(f"/api/runs/{live_run}/previous") and r.method == "POST",
        timeout=10_000,
    ):
        page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(400)

    with page.expect_request(
        lambda r: r.url.endswith(f"/api/runs/{live_run}/pause") and r.method == "POST",
        timeout=10_000,
    ):
        page.keyboard.press("Space")


def test_transport_keys_are_inert_while_typing_in_a_field(page, live_run):
    """The counter-test: a focused field swallows the transport keys.

    Without this the arrow keys of a text filter would skip the listener's
    music, which is the classic way a global key handler ruins a page.
    """
    calls: list[str] = []
    page.on(
        "request",
        lambda r: calls.append(r.url) if r.method == "POST" and "/api/runs/" in r.url else None,
    )

    # A real text field: the library filter.
    page.goto("/library", wait_until="networkidle")
    page.wait_for_selector("#plFilter")
    page.click("#plFilter")
    page.keyboard.type("Kurzes")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Space")
    page.wait_for_timeout(600)
    assert not calls, f"typing in #plFilter triggered run calls: {calls}"

    # And the select on the player, which the same handler has to respect.
    page.goto(f"/player/{live_run}", wait_until="networkidle")
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    calls.clear()
    page.focus("#deviceSelect")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Space")
    page.wait_for_timeout(1_200)
    transport = [c for c in calls if c.endswith(("/advance", "/previous", "/pause", "/start"))]
    assert not transport, f"keys inside #deviceSelect drove the transport: {transport}"


def test_transport_buttons_are_reachable_and_operable_by_keyboard(page, live_run):
    page.goto(f"/player/{live_run}", wait_until="networkidle")
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    page.focus("#mainBtn")
    focused = page.evaluate(helpers.JS_ACTIVE_ELEMENT)
    assert focused["id"] == "mainBtn"
    assert helpers.px(focused["outline_width"]) >= 2, (
        f"the main transport button has no focus ring: {focused['outline_width']}"
    )
    with page.expect_request(
        lambda r: r.url.endswith(f"/api/runs/{live_run}/pause") and r.method == "POST",
        timeout=10_000,
    ):
        page.keyboard.press("Enter")
