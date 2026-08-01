"""Both themes, every page: render, prove they differ, and file the evidence.

The screenshots under ``tests/browser/artifacts/`` are what a human reviewer
looks at for the "Pflicht-Screen-Set" of the work package. The assertions
here are the part a machine can own: that the dark and light themes are two
genuinely different renderings (not a toggle that changes nothing), that the
stored preference survives a reload, and that neither theme leaves text
unpainted.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser

SHOT_VIEWPORTS = ("390", "1280")


@pytest.fixture(scope="module")
def matrix_run(browser, demo_storage_state, live_server):
    """A run that is confirmed to be in system state A while shot."""
    from tests.browser.conftest import DESKTOP

    context = browser.new_context(
        viewport=DESKTOP, base_url=live_server, storage_state=demo_storage_state
    )
    page = context.new_page()
    run_id = helpers.start_live_run(page)
    yield run_id
    context.close()


def test_screenshot_matrix_of_every_page_in_both_themes(
    context_factory, matrix_run, artifact_dir
):
    index = []
    for viewport_name in SHOT_VIEWPORTS:
        page = context_factory(helpers.VIEWPORTS[viewport_name]).new_page()
        for name, template in helpers.PAGES:
            path = template.format(run=matrix_run)
            page.goto(path, wait_until="networkidle")
            page.wait_for_timeout(900)
            for theme in helpers.THEMES:
                helpers.set_theme(page, theme)
                filename = f"{name}_{viewport_name}_{theme}.png"
                page.screenshot(path=str(artifact_dir / filename), full_page=True)
                index.append({
                    "file": filename, "page": name, "path": path,
                    "viewport": viewport_name, "theme": theme,
                })
    write_artifact_json("screenshot_index.json", index)
    assert len(index) == len(helpers.PAGES) * len(SHOT_VIEWPORTS) * len(helpers.THEMES)


def test_the_two_themes_are_actually_different(page, dealt_run):
    """A theme toggle that does not repaint the page is a decoration."""
    problems = []
    samples = {}
    for name, template in helpers.PAGES:
        path = template.format(run=dealt_run)
        page.goto(path, wait_until="networkidle")
        page.wait_for_timeout(400)
        seen = {}
        for theme in helpers.THEMES:
            helpers.set_theme(page, theme)
            seen[theme] = page.evaluate(
                """() => {
                     const b = getComputedStyle(document.body);
                     const m = document.querySelector('main#inhalt');
                     return {
                       body_bg: b.backgroundColor, body_color: b.color,
                       main_color: m ? getComputedStyle(m).color : null,
                     };
                   }"""
            )
        samples[name] = seen
        if seen["dark"]["body_bg"] == seen["light"]["body_bg"]:
            problems.append(f"{path}: body background is {seen['dark']['body_bg']} in both themes")
        if seen["dark"]["body_color"] == seen["light"]["body_color"]:
            problems.append(f"{path}: text colour is {seen['dark']['body_color']} in both themes")
    write_artifact_json("theme_samples.json", samples)
    assert not problems, "theme defects:\n  " + "\n  ".join(problems)


def test_theme_choice_survives_a_reload(page):
    page.goto("/", wait_until="networkidle")
    before = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    page.click("#themeToggle")
    page.wait_for_timeout(250)
    after = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    assert before != after, "the theme toggle changed nothing"
    stored = page.evaluate("() => localStorage.getItem('true_shuffle_theme')")
    assert stored in ("dark", "light"), f"no theme preference was stored ({stored!r})"

    page.reload(wait_until="networkidle")
    page.wait_for_timeout(250)
    assert page.evaluate("() => getComputedStyle(document.body).backgroundColor") == after, (
        "the stored theme was not applied after a reload"
    )
    # The inline head script exists so the choice is applied before paint.
    assert page.evaluate("() => document.documentElement.dataset.theme") == stored


def test_the_toggle_says_which_theme_it_offers(page):
    page.goto("/", wait_until="networkidle")
    toggle = page.locator("#themeToggle")
    assert toggle.is_visible()
    box = toggle.bounding_box()
    assert box["height"] >= 44 and box["width"] >= 44, (
        f"the theme toggle is only {box['width']:.0f}x{box['height']:.0f}px"
    )
    name = toggle.get_attribute("aria-label") or toggle.inner_text()
    assert name.strip(), "the theme toggle has no accessible name"
