"""No page may scroll sideways at any of the fixed viewports.

320 is the floor the stylesheet declares; 390 / 768 / 1280 are the phone,
tablet and desktop widths the work package fixes for the visual acceptance.
Long German compounds and long playlist names are the usual cause, so the
worst-case names the demo library provides are on screen while this runs.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser


@pytest.mark.parametrize("viewport_name", list(helpers.VIEWPORTS))
def test_no_horizontal_overflow(context_factory, dealt_run, viewport_name):
    page = context_factory(helpers.VIEWPORTS[viewport_name]).new_page()
    report = {}
    problems = []
    for name, template in helpers.PAGES:
        path = template.format(run=dealt_run)
        page.goto(path, wait_until="networkidle")
        page.wait_for_timeout(700)
        # Rules and explanations are collapsed by default; an accordion that
        # only overflows when open still overflows.
        page.evaluate("() => document.querySelectorAll('details').forEach((d) => (d.open = true))")
        page.wait_for_timeout(300)
        result = page.evaluate(helpers.JS_HORIZONTAL_OVERFLOW)
        report[name] = result
        if result["scroll_width"] > result["client_width"]:
            problems.append(
                f"{path}: scrollWidth {result['scroll_width']} > clientWidth "
                f"{result['client_width']}; first offenders: "
                + ", ".join(f"{c['tag']}.{c['cls']}({c['left']}…{c['right']})"
                            for c in result["culprits"][:4])
            )
    write_artifact_json(f"overflow_{viewport_name}.json", report)
    assert not problems, f"horizontal overflow at {viewport_name}px:\n  " + "\n  ".join(problems)


def test_navigation_stays_reachable_on_a_phone(context_factory):
    """The app bar may scroll sideways, but it may not swallow destinations.

    At 320 and 390 the five nav links do not fit next to the wordmark, and
    ``.appnav`` solves that with ``overflow-x: auto``. That is only
    acceptable while the overflowing links stay reachable — a nav clipped
    with ``overflow: hidden`` would strand a phone user on two of five
    sections. How many links start off-screen is recorded for review, since
    the scrollbar is hidden (``scrollbar-width: none``) and there is no other
    affordance.
    """
    report = {}
    problems = []
    for viewport_name in ("320", "390"):
        page = context_factory(helpers.VIEWPORTS[viewport_name]).new_page()
        page.goto("/", wait_until="networkidle")
        page.wait_for_timeout(400)
        measurement = page.evaluate(
            """() => {
                 const nav = document.querySelector('.appnav');
                 const cs = getComputedStyle(nav);
                 const box = nav.getBoundingClientRect();
                 const links = [...nav.querySelectorAll('a')].map((a) => {
                   const r = a.getBoundingClientRect();
                   return { href: a.getAttribute('href'),
                            fully_visible: r.left >= box.left - 1 && r.right <= box.right + 1 };
                 });
                 return {
                   overflow_x: cs.overflowX,
                   scroll_width: nav.scrollWidth,
                   client_width: nav.clientWidth,
                   links,
                 };
               }"""
        )
        report[viewport_name] = measurement
        hidden = [link["href"] for link in measurement["links"] if not link["fully_visible"]]
        measurement["initially_off_screen"] = hidden
        if measurement["scroll_width"] > measurement["client_width"] + 1 and \
                measurement["overflow_x"] not in ("auto", "scroll"):
            problems.append(
                f"{viewport_name}: .appnav overflows but is {measurement['overflow_x']} — "
                f"{hidden} cannot be reached"
            )
        # Whatever the layout, every destination has to exist and be focusable.
        assert len(measurement["links"]) == 5, measurement["links"]

    write_artifact_json("mobile_navigation.json", report)
    assert not problems, "mobile navigation:\n  " + "\n  ".join(problems)


def test_long_names_wrap_instead_of_clipping(context_factory, dealt_run):
    """ADR-001 Auflage 3: playlist names wrap fully, never ``line-clamp``."""
    page = context_factory(helpers.VIEWPORTS["320"]).new_page()
    problems = []
    for path, selector in (
        ("/runs", ".run-title"),
        (f"/player/{dealt_run}", "h1"),
        (f"/runs/{dealt_run}/verlauf", "h1"),
    ):
        page.goto(path, wait_until="networkidle")
        page.wait_for_selector(selector)
        page.wait_for_timeout(500)
        styles = page.eval_on_selector(
            selector,
            """(e) => {
                 const cs = getComputedStyle(e);
                 return {
                   clamp: cs.webkitLineClamp,
                   overflow: cs.overflow,
                   text_overflow: cs.textOverflow,
                   wrap: cs.overflowWrap,
                   scroll_width: e.scrollWidth,
                   client_width: e.clientWidth,
                 };
               }""",
        )
        if styles["clamp"] not in ("none", "", None):
            problems.append(f"{path} {selector}: -webkit-line-clamp={styles['clamp']}")
        if styles["text_overflow"] == "ellipsis":
            problems.append(f"{path} {selector}: text-overflow: ellipsis")
        if styles["scroll_width"] > styles["client_width"] + 1:
            problems.append(
                f"{path} {selector}: content is clipped "
                f"({styles['scroll_width']} > {styles['client_width']})"
            )
    assert not problems, "text truncation defects:\n  " + "\n  ".join(problems)
