"""Structural accessibility of every page: landmark, heading, nav, meters, chips.

These are the ADR-001 Auflagen 4/5/6/7 and the work package's
"Screenreader-Semantik der wichtigsten Controls" expressed as assertions a
machine can re-run.
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import write_artifact_json

pytestmark = pytest.mark.browser

#: Pages that are reachable from the app bar and must therefore mark
#: themselves in the navigation.
NAV_PAGES = {
    "/": "/",
    "/connect": "/connect",
    "/library": "/library",
    "/runs": "/runs",
    "/konfigurationen": "/konfigurationen",
}


def _structure(page, path: str) -> dict:
    page.goto(path, wait_until="networkidle")
    page.wait_for_timeout(500)
    return page.evaluate(helpers.JS_PAGE_STRUCTURE)


def test_every_page_has_exactly_one_main_inhalt_and_one_h1(page, dealt_run):
    """One ``<main id="inhalt">`` and one ``<h1>`` per page — no exceptions."""
    report = {}
    problems = []
    for name, template in helpers.PAGES:
        path = template.format(run=dealt_run)
        structure = _structure(page, path)
        report[name] = {
            "path": path,
            "main_count": structure["main_count"],
            "main_inhalt_count": structure["main_inhalt_count"],
            "h1": structure["h1"],
            "lang": structure["lang"],
        }
        if structure["main_count"] != 1:
            problems.append(f"{path}: {structure['main_count']} <main> elements")
        if structure["main_inhalt_count"] != 1:
            problems.append(f"{path}: {structure['main_inhalt_count']} main#inhalt")
        if len(structure["h1"]) != 1:
            problems.append(f"{path}: {len(structure['h1'])} <h1> ({structure['h1']})")
        if structure["lang"] != "de":
            problems.append(f"{path}: <html lang> is {structure['lang']!r}, expected 'de'")

    write_artifact_json("a11y_structure.json", report)
    assert not problems, "landmark/heading defects:\n  " + "\n  ".join(problems)


def test_navigation_marks_the_current_page(page, dealt_run):
    """Every nav destination sets ``aria-current="page"`` on its own link."""
    problems = []
    for path, expected_href in NAV_PAGES.items():
        structure = _structure(page, path)
        current = structure["aria_current"]
        if len(current) != 1:
            problems.append(f"{path}: {len(current)} nav links carry aria-current ({current})")
            continue
        if current[0]["href"] != expected_href:
            problems.append(f"{path}: aria-current sits on {current[0]['href']}")
        if current[0]["value"] != "page":
            problems.append(f"{path}: aria-current={current[0]['value']!r}, expected 'page'")
    assert not problems, "navigation state defects:\n  " + "\n  ".join(problems)


def test_run_subpages_mark_their_nav_section(page, dealt_run):
    """A page *inside* a section still highlights that section in the nav.

    ``/runs/{id}/verlauf`` does this (base.html matches ``/runs/``); the
    player is the same kind of page — a single run — and is expected to be
    consistent with it.
    """
    problems = []
    for path in (f"/runs/{dealt_run}/verlauf", f"/player/{dealt_run}"):
        structure = _structure(page, path)
        current = [c["href"] for c in structure["aria_current"]]
        if current != ["/runs"]:
            problems.append(f"{path}: nav aria-current is {current}, expected ['/runs']")
    assert not problems, "sub-page navigation state:\n  " + "\n  ".join(problems)


def test_live_meters_are_progressbars_with_a_value(page, live_run):
    """Wherever a meter shows real progress it must be a valued progressbar.

    ADR-001 Auflage 6 ("role=progressbar mit Geschwister-Label") and
    Auflage 7 ("Meter-Track-Sichtbarkeit").
    """
    problems = []
    for path in (f"/player/{live_run}", "/runs"):
        structure = _structure(page, path)
        meters = structure["meters"]
        assert meters, f"{path}: no meter found at all"
        for meter in meters:
            if meter["role"] != "progressbar":
                problems.append(f"{path}: .{meter['cls']} has role={meter['role']!r}")
                continue
            for attribute in ("valuenow", "valuemin", "valuemax"):
                if meter[attribute] is None:
                    problems.append(f"{path}: .{meter['cls']} misses aria-{attribute}")
            if not meter["label"]:
                problems.append(f"{path}: .{meter['cls']} has no accessible name")
    assert not problems, "progressbar semantics:\n  " + "\n  ".join(problems)


def test_styleguide_meter_specimens_are_named(page):
    """Static specimens may be images, but they may not be nameless boxes."""
    structure = _structure(page, "/styleguide")
    problems = [
        f".{m['cls']} role={m['role']!r} label={m['label']!r}"
        for m in structure["meters"]
        if not (
            (m["role"] == "img" and m["label"])
            or (m["role"] == "progressbar" and m["valuenow"] is not None)
        )
    ]
    assert not problems, "unnamed meter specimens:\n  " + "\n  ".join(problems)


def test_progress_meters_use_only_the_ink_axis_and_signal(page, live_run):
    """ADR-001 Auflage 4: state colours stay reserved for system state.

    Asserted on the shipped product screens, where the requirement binds:
    the run meter on /player and the card meters on /runs may only be filled
    from the ink axis or the signal. The styleguide's not-yet-shipped
    statistics meter is measured too, but only recorded — its segments are a
    specimen of a screen this phase does not build, and the reading of
    "Statistik" for a played/skipped/excluded breakdown is a call for the
    design lead, not for a test.
    """
    probe = """
    () => {
      const tokens = getComputedStyle(document.documentElement);
      const read = (name) => tokens.getPropertyValue(name).trim().toLowerCase();
      const reserved = {
        'state-b': read('--state-b'), 'state-c': read('--state-c'), 'state-d': read('--state-d'),
      };
      const rgb = (hex) => {
        const m = hex.replace('#', '');
        if (m.length !== 6) return null;
        const [r, g, b] = [m.slice(0,2), m.slice(2,4), m.slice(4,6)].map((h) => parseInt(h, 16));
        return `rgb(${r}, ${g}, ${b})`;
      };
      const out = [];
      for (const bar of document.querySelectorAll('.mini-meter, .meter, .job-bar')) {
        for (const fill of bar.querySelectorAll('i')) {
          const bg = getComputedStyle(fill).backgroundColor;
          const image = getComputedStyle(fill).backgroundImage;
          const hits = Object.entries(reserved)
            .filter(([, value]) => {
              const asRgb = rgb(value);
              return (asRgb && (bg === asRgb || image.includes(asRgb)))
                     || (value && image.includes(value));
            })
            .map(([name]) => name);
          out.push({
            bar: String(bar.className).slice(0, 30),
            fill: String(fill.className).slice(0, 20),
            background: bg, image: image.slice(0, 60), reserved_hits: hits,
          });
        }
      }
      return out;
    }
    """
    findings = {}
    problems = []
    for path in (f"/player/{live_run}", "/runs", "/styleguide"):
        page.goto(path, wait_until="networkidle")
        page.wait_for_timeout(700)
        fills = page.evaluate(probe)
        findings[path] = fills
        if path == "/styleguide":
            continue
        for fill in fills:
            if fill["reserved_hits"]:
                problems.append(
                    f"{path}: .{fill['bar']} > .{fill['fill']} is filled with "
                    f"{fill['reserved_hits']} ({fill['background']})"
                )
    write_artifact_json("meter_colours.json", findings)
    assert not problems, "reserved state colours used for progress:\n  " + "\n  ".join(problems)


def test_system_state_chips_carry_text_not_only_colour(page, dealt_run):
    """Colour and icon are never the only carrier of a system state.

    ADR-001's whole case for "Nachtpult" rests on state being readable in
    greyscale, so every chip has to say what it means in words.
    """
    problems = []
    seen_states = set()
    for _name, template in helpers.PAGES:
        path = template.format(run=dealt_run)
        structure = _structure(page, path)
        for chip in structure["chips"]:
            if not chip["text"]:
                problems.append(f"{path}: chip '{chip['cls']}' has no text")
            for state in ("chip-a", "chip-b", "chip-c", "chip-d"):
                if state in chip["cls"].split():
                    seen_states.add(state)
                    if len(chip["text"]) < 4:
                        problems.append(
                            f"{path}: state chip '{chip['cls']}' text is {chip['text']!r}"
                        )
    assert not problems, "chip labelling defects:\n  " + "\n  ".join(problems)
    assert seen_states >= {"chip-a", "chip-b", "chip-c", "chip-d"}, (
        f"the four system states are not all documented in the UI: {sorted(seen_states)}"
    )


def test_run_cards_carry_the_contract_vocabulary(page, live_run):
    """ADR-001 Auflage 5: contract word *in addition to* the system state."""
    page.goto("/runs", wait_until="networkidle")
    page.wait_for_selector("[data-run-id]")
    page.wait_for_timeout(800)
    card = page.locator(f'[data-run-id="{live_run}"]')
    chips = card.locator(".chip").all_text_contents()
    texts = [c.strip() for c in chips]
    assert any(t in helpers.CONTRACT_WORDS for t in texts), (
        f"run card {live_run} shows no contract word, only {texts}"
    )
    assert len(texts) >= 2, (
        f"run card {live_run} shows only {texts} — the system state chip is missing"
    )


def test_transport_buttons_expose_a_reason_when_they_are_blocked(page, live_run):
    """A disabled primary action explains itself in its accessible name."""
    page.goto(f"/player/{live_run}", wait_until="networkidle")
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    names = page.evaluate(
        """() => ['#prevBtn', '#mainBtn', '#nextBtn'].map((id) => {
             const b = document.querySelector(id);
             return { id, label: b.getAttribute('aria-label'),
                      disabled: b.getAttribute('aria-disabled') };
           })"""
    )
    for entry in names:
        assert entry["label"], f"{entry['id']} has no aria-label"
        if entry["disabled"] == "true":
            assert "–" in entry["label"] or "-" in entry["label"], (
                f"{entry['id']} is aria-disabled but its name gives no reason: {entry['label']!r}"
            )
