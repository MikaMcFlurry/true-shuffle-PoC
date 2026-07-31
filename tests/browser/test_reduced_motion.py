"""``prefers-reduced-motion: reduce`` must actually stop the motion.

The Aurora arc on the home page and the skeleton shimmer are the two
signature animations of this direction, and they are exactly the kind of
thing that keeps ticking when a stylesheet only shortens durations. So the
check is not "is there a media query" but "does ``document.getAnimations()``
still report anything running".
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser

REDUCED_PAGES = ("/", "/player/{run}", "/styleguide")


def test_no_animation_runs_under_reduced_motion(context_factory, dealt_run):
    context = context_factory(reduced_motion="reduce")
    page = context.new_page()
    report = {}
    problems = []
    for template in REDUCED_PAGES:
        path = template.format(run=dealt_run)
        page.goto(path, wait_until="networkidle")
        # Give any entry transition the time it would need to be caught.
        page.wait_for_timeout(1_800)
        running = page.evaluate(helpers.JS_RUNNING_ANIMATIONS)
        report[path] = running
        if running:
            problems.append(
                f"{path}: {len(running)} running animation(s): "
                + ", ".join(f"{a['name']} on {a['target']}" for a in running[:5])
            )
    write_artifact_json("reduced_motion.json", report)
    assert not problems, "reduced motion is not honoured:\n  " + "\n  ".join(problems)


def test_theme_switch_does_not_animate_under_reduced_motion(context_factory, dealt_run):
    """Switching theme is the one interaction that repaints the whole page."""
    page = context_factory(reduced_motion="reduce").new_page()
    page.goto("/", wait_until="networkidle")
    page.click("#themeToggle")
    page.wait_for_timeout(120)
    running = page.evaluate(helpers.JS_RUNNING_ANIMATIONS)
    assert not running, f"theme switch animates under reduced motion: {running}"


def test_motion_exists_when_it_is_not_suppressed(context_factory):
    """A control test: the reduce result above must mean something.

    If nothing on the home page ever animates, the assertion above would pass
    for the wrong reason. The Aurora arc is declared as an infinite animation
    in style.css, so with motion allowed it has to be reported.
    """
    page = context_factory(reduced_motion="no-preference").new_page()
    page.goto("/", wait_until="networkidle")
    page.wait_for_timeout(600)
    declared = page.evaluate(
        """() => document.getAnimations().map((a) => ({
             name: a.animationName || a.transitionProperty || '?',
             state: a.playState,
           }))"""
    )
    assert declared, (
        "no animation at all with motion allowed — the reduced-motion test "
        "above cannot prove anything"
    )
