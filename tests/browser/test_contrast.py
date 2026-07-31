"""Automated contrast spot-check (WCAG 2.1 §1.4.3, AA).

The ratio is computed here rather than trusted from a design token table:
computed styles are read out of the live page, every ancestor background and
every ``opacity`` on the way up is composited, and the result goes through a
hand-rolled implementation of the WCAG formula (``helpers.contrast_ratio``).
That makes a failure reproducible with nothing but a browser and a
calculator.

Both themes are measured, because ADR-001 sold "Nachtpult" partly on being
the only concept with a fully measured second theme.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser

#: The styleguide renders every component twice, once inside a
#: ``data-theme="dark"`` container and once inside a ``data-theme="light"``
#: one. Each specimen is therefore addressed through its own pane, so the
#: measurement says which of the two themes a number belongs to instead of
#: silently taking whichever came first in the DOM.
def _panes(selector: str, description: str):
    return [
        (
            "/styleguide",
            f'.theme-preview[data-theme="{pane}"] {selector}',
            f"{description} [Pane {pane}]",
        )
        for pane in ("dark", "light")
    ]


#: (page, selector, human description) — chip texts on their own
#: backgrounds, muted text on the surfaces it really sits on, banner copy.
SAMPLES = [
    *_panes(".chip-a", "Zustand-A-Chip"),
    *_panes(".chip-b", "Zustand-B-Chip"),
    *_panes(".chip-c", "Zustand-C-Chip"),
    *_panes(".chip-d", "Zustand-D-Chip"),
    *_panes(".chip-neutral", "Vertragschip (neutral)"),
    *_panes(".chip-preview", "Vorschau-Chip"),
    *_panes(".chip-error", "Fehler-Chip"),
    *_panes('.btn[aria-disabled="true"]', "Deaktivierte Primäraktion"),
    *_panes(".banner-b .banner-title", "Banner B — Titel"),
    *_panes(".banner-b .banner-body", "Banner B — Fließtext"),
    *_panes(".banner-b .banner-policy", "Banner B — Regelzeile"),
    *_panes(".banner-c .banner-body", "Banner C — Fließtext"),
    *_panes(".banner-d .banner-body", "Banner D — Fließtext"),
    *_panes(".banner-error .banner-body", "Banner Fehler — Fließtext"),
    ("/library", ".card-read", "Kartenwert auf Surface"),
    ("/library", ".field-hint", "Feldhinweis auf Surface"),
    ("/library", ".p-desc", "Preset-Beschreibung"),
    ("/library", ".chip-preview", "Vorschau-Chip im Produkt"),
    ("/runs", ".run-progressline", "Fortschrittszeile auf Karte"),
    ("/player/{run}", ".zone-caption", "Zonenbeschriftung"),
    ("/player/{run}", ".transport-hint", "Transporthinweis"),
    ("/player/{run}", ".track-artist", "Interpret in der Wiedergabe-Zone"),
    ("/player/{run}", ".fold .dim", "Erklärtext im Akkordeon (dim)"),
    ("/player/{run}", ".fold .faint", "Erklärtext im Akkordeon (faint)"),
    ("/", ".app-footer .claim", "Fußzeilen-Zusage"),
    ("/", ".hero .lede", "Einstiegstext"),
]


def _measure(page, theme, path, selector, dealt_run):
    resolved = path.format(run=dealt_run)
    page.goto(resolved, wait_until="networkidle")
    helpers.set_theme(page, theme)
    page.wait_for_timeout(250)
    element = page.query_selector(selector)
    if element is None:
        return None
    # Open every <details> so text inside an accordion is really rendered.
    page.evaluate("() => document.querySelectorAll('details').forEach((d) => (d.open = true))")
    page.wait_for_timeout(120)
    element = page.query_selector(selector)
    if element is None or not element.is_visible():
        return None
    data = element.evaluate(helpers.JS_EFFECTIVE_COLORS)
    ratio = helpers.contrast_ratio(data["color"], data["background"])
    needed = helpers.required_ratio(helpers.px(data["font_size"]), data["font_weight"])
    return {
        "theme": theme,
        "page": resolved,
        "selector": selector,
        "text": data["text"],
        "color": [round(c, 1) for c in data["color"]],
        "background": [round(c, 1) for c in data["background"]],
        "font_size": data["font_size"],
        "font_weight": data["font_weight"],
        "opacity": round(data["opacity"], 3),
        "ratio": round(ratio, 2),
        "required": needed,
        "passes": ratio + 1e-9 >= needed,
    }


def test_contrast_sample_meets_wcag_aa(page, dealt_run):
    """Every sampled text pair clears its AA threshold in both themes."""
    results = []
    missing = []
    for theme in helpers.THEMES:
        for path, selector, description in SAMPLES:
            measured = _measure(page, theme, path, selector, dealt_run)
            if measured is None:
                missing.append(f"{theme} {path} {selector}")
                continue
            measured["description"] = description
            results.append(measured)

    write_artifact_json("contrast.json", {"samples": results, "not_found": missing})

    assert not missing, "contrast samples that did not render:\n  " + "\n  ".join(missing)
    failures = [
        f"{r['theme']:5s} {r['page']:22s} {r['selector']:26s} "
        f"{r['ratio']:.2f}:1 < {r['required']:.1f}:1  "
        f"rgb{tuple(r['color'])} auf rgb{tuple(r['background'])}  {r['text']!r}"
        for r in results
        if not r["passes"]
    ]
    assert not failures, (
        f"{len(failures)} of {len(results)} sampled pairs miss WCAG AA:\n  "
        + "\n  ".join(failures)
    )


def test_live_system_state_chip_contrast(page, live_run):
    """The chip a listener actually reads, in the running product, both themes.

    Separate from the styleguide sample above on purpose: the styleguide's
    side-by-side panes and the real page resolve their tokens differently,
    and the number that matters for the listener is this one.
    """
    results = []
    problems = []
    for theme in helpers.THEMES:
        page.goto(f"/player/{live_run}", wait_until="networkidle")
        helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
        helpers.set_theme(page, theme)
        page.wait_for_timeout(200)
        for selector in ("#stateChip", "#contractChip"):
            data = page.eval_on_selector(selector, helpers.JS_EFFECTIVE_COLORS)
            ratio = helpers.contrast_ratio(data["color"], data["background"])
            needed = helpers.required_ratio(
                helpers.px(data["font_size"]), data["font_weight"]
            )
            results.append({
                "theme": theme, "selector": selector, "text": data["text"],
                "color": [round(c, 1) for c in data["color"]],
                "background": [round(c, 1) for c in data["background"]],
                "ratio": round(ratio, 2), "required": needed,
            })
            if ratio + 1e-9 < needed:
                problems.append(
                    f"{theme} {selector} ({data['text']!r}): {ratio:.2f}:1 < {needed:.1f}:1"
                )
    write_artifact_json("contrast_live_chips.json", results)
    assert not problems, "live state chips miss WCAG AA:\n  " + "\n  ".join(problems)


def test_focus_ring_is_visible_against_its_surface(page, dealt_run):
    """The focus outline itself has to be seen — 3:1 against what it sits on.

    WCAG 2.1 §1.4.11 (non-text contrast) applied to the ``:focus-visible``
    ring, which is the only thing marking keyboard position in this UI.
    """
    problems = []
    details = []
    for theme in helpers.THEMES:
        page.goto(f"/player/{dealt_run}", wait_until="networkidle")
        helpers.set_theme(page, theme)
        page.keyboard.press("Tab")  # skip link
        page.keyboard.press("Tab")  # wordmark
        focused = page.evaluate(helpers.JS_ACTIVE_ELEMENT)
        # The ring is drawn outside the control (outline-offset), so it lands
        # on whatever the control's parent paints.
        surface = page.evaluate(
            f"() => ({helpers.JS_EFFECTIVE_COLORS})(document.activeElement.parentElement)"
        )
        raw = focused["outline_color"].replace("rgba(", "").replace("rgb(", "").rstrip(")")
        ring = [float(v) for v in raw.split(",")[:3]]
        ratio = helpers.contrast_ratio(ring, surface["background"])
        details.append({
            "theme": theme,
            "focused": helpers.describe(focused),
            "outline": focused["outline_color"],
            "outline_width": focused["outline_width"],
            "surface": [round(c, 1) for c in surface["background"]],
            "ratio": round(ratio, 2),
        })
        if focused["outline_style"] == "none" or helpers.px(focused["outline_width"]) < 2:
            problems.append(
                f"{theme}: focus ring is {focused['outline_width']} {focused['outline_style']}"
            )
        if ratio < 3.0:
            problems.append(f"{theme}: focus ring contrast {ratio:.2f}:1 < 3:1")

    write_artifact_json("focus_ring_contrast.json", details)
    assert not problems, "focus ring visibility:\n  " + "\n  ".join(problems)
