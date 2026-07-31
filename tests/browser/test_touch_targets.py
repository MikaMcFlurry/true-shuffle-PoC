"""Touch-target sizes on the three pages that are used while moving.

Rules applied, and the reason each one is what it is:

* **44 x 44 CSS px minimum** for everything a pointer can operate — the
  ADR-001 promise ("keine Unterschreitung der 44px-Touch-Ziele") and WCAG
  2.5.5 AAA. The work package puts the main use in a car, so the AAA number
  is the product requirement, not the AA fallback of 24px.
* **``aria-disabled`` elements are measured too.** They still take clicks
  (``player.html`` and ``app.js`` guard them in JavaScript, the browser does
  not), so a listener can and will hit them — a soft-disabled control that is
  too small is a target that is too small.
* **Natively ``disabled`` controls are not targets.** The user agent accepts
  no pointer action on them at all, so WCAG's definition of "target" does not
  cover them. They are reported in the artifact for the record, never
  asserted on.
* **A control bound to a label is measured as that label**, because that is
  the region a finger can actually hit.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser

MIN_TARGET = 44.0
MIN_MAIN_TRANSPORT = 56.0

PAGES_UNDER_TEST = ("/runs", "/library", "/player/{run}")


def _collect(page, path, viewport_name):
    page.goto(path, wait_until="networkidle")
    page.wait_for_timeout(900)
    # Rules live behind <details>; a collapsed control is not a target, so
    # open everything to measure the worst case honestly.
    page.evaluate("() => document.querySelectorAll('details').forEach((d) => (d.open = true))")
    page.wait_for_timeout(300)
    nodes = page.evaluate(helpers.JS_INTERACTIVE_TARGETS)
    for node in nodes:
        node["page"] = path
        node["viewport"] = viewport_name
    return nodes


def test_all_operable_targets_are_at_least_44px(context_factory, dealt_run):
    measured = []
    failures = []
    excluded = []

    for viewport_name in ("390", "1280"):
        page = context_factory(helpers.VIEWPORTS[viewport_name]).new_page()
        for template in PAGES_UNDER_TEST:
            path = template.format(run=dealt_run)
            for node in _collect(page, path, viewport_name):
                if node["native_disabled"]:
                    excluded.append(node)
                    continue
                measured.append(node)
                if (
                    node["effective_width"] < MIN_TARGET
                    or node["effective_height"] < MIN_TARGET
                ):
                    failures.append(node)

    write_artifact_json(
        "touch_targets.json",
        {
            "min_px": MIN_TARGET,
            "measured": len(measured),
            "failures": failures,
            "not_measured_native_disabled": excluded,
        },
    )

    assert measured, "no interactive elements were measured at all"
    report = "\n  ".join(
        f"{f['viewport']:>4} {f['page']:20s} {helpers.describe(f):22s} "
        f"{f['effective_width']}x{f['effective_height']}px  {f['name']!r}"
        for f in failures
    )
    assert not failures, (
        f"{len(failures)} of {len(measured)} operable targets are under "
        f"{MIN_TARGET:.0f}px:\n  {report}"
    )


def test_main_transport_button_is_at_least_56px(context_factory, dealt_run):
    """The one control that gets pressed while driving."""
    problems = []
    for viewport_name in ("320", "390", "768", "1280"):
        page = context_factory(helpers.VIEWPORTS[viewport_name]).new_page()
        page.goto(f"/player/{dealt_run}", wait_until="networkidle")
        page.wait_for_selector("#mainBtn")
        page.wait_for_timeout(600)
        box = page.locator("#mainBtn").bounding_box()
        assert box, f"{viewport_name}: #mainBtn did not render"
        if box["width"] < MIN_MAIN_TRANSPORT or box["height"] < MIN_MAIN_TRANSPORT:
            problems.append(
                f"{viewport_name}: #mainBtn is {box['width']:.0f}x{box['height']:.0f}px"
            )
        for other in ("#prevBtn", "#nextBtn"):
            side = page.locator(other).bounding_box()
            if side["width"] < MIN_TARGET or side["height"] < MIN_TARGET:
                problems.append(
                    f"{viewport_name}: {other} is {side['width']:.0f}x{side['height']:.0f}px"
                )
    assert not problems, "transport sizing:\n  " + "\n  ".join(problems)


#: A common phone, at the size the CSS viewport reports it.
PHONE = {"width": 390, "height": 844}


def test_transport_sits_in_the_first_screen_on_a_phone(context_factory, dealt_run):
    """ADR-001 rejected one concept for putting the transport below the fold.

    The winning direction sold itself on driving ergonomics, so the control
    a listener reaches for must be on screen when the player opens — no
    scrolling, on a phone-sized viewport.
    """
    page = context_factory(PHONE).new_page()
    page.goto(f"/player/{dealt_run}", wait_until="networkidle")
    page.wait_for_selector("#mainBtn")
    page.wait_for_timeout(800)
    box = page.locator("#mainBtn").bounding_box()
    assert box, "#mainBtn did not render"
    # Recorded, not asserted: where the other orientation-carrying elements
    # land on the same screen. The system-state chip lives at the top of the
    # run zone, i.e. below the playback zone on a phone — review material for
    # "the listener can always tell who is in charge".
    landmarks = {}
    for selector in ("h1", "#contractChip", "#mainBtn", "#stateChip", "#runMeter"):
        node = page.locator(selector).first
        rect = node.bounding_box() if node.count() else None
        landmarks[selector] = None if rect is None else {
            "top": round(rect["y"]), "bottom": round(rect["y"] + rect["height"]),
            "within_first_screen": rect["y"] + rect["height"] <= PHONE["height"],
        }
    write_artifact_json(
        "transport_fold.json",
        {"viewport": PHONE, "fold_px": PHONE["height"], "landmarks": landmarks},
    )
    assert box["y"] + box["height"] <= PHONE["height"], (
        f"the main transport button ends at y={box['y'] + box['height']:.0f}px, "
        f"below the {PHONE['height']}px fold of a phone"
    )


def test_disabled_preview_controls_are_still_labelled(page, dealt_run):
    """A control nobody can press must still say what it is.

    These are the "Vorschau" rules on /library. They are exempt from the
    target-size rule because the browser refuses them any pointer action —
    they are not exempt from having an accessible name, and a screen reader
    reads the whole rule list.
    """
    page.goto("/library", wait_until="networkidle")
    page.evaluate("() => document.querySelectorAll('details').forEach((d) => (d.open = true))")
    page.wait_for_timeout(300)
    nameless = page.evaluate(
        """() => {
             const out = [];
             for (const e of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
               const wrapping = e.closest('label');
               const bound = e.id
                 ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]')
                 : null;
               const aria = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
               if (!wrapping && !bound && !aria) {
                 out.push({
                   name: e.getAttribute('name'),
                   disabled: e.disabled,
                   nearby: (e.parentElement.textContent || '')
                     .replace(/\\s+/g, ' ').trim().slice(0, 60),
                 });
               }
             }
             return out;
           }"""
    )
    write_artifact_json("unlabelled_controls.json", nameless)
    assert not nameless, (
        f"{len(nameless)} radio/checkbox controls have no associated label:\n  "
        + "\n  ".join(f"name={n['name']!r} near {n['nearby']!r}" for n in nameless)
    )
