"""System state B: the service was taken over manually, and the way back.

How the takeover is provoked
============================

WP3-D3 / F8 (ADR-003): the pre-D3 version of this fixture started a SECOND
Live run to steal the shared demo speaker.  That path died with
``idx_runs_one_playing`` — a second controller run now honestly starts
'paused' and can no longer claim the device (SP-003: one driver per device).
That is the product being MORE correct, not the scenario disappearing: the
real-world trigger for state B was never "another True-Shuffle run", it was
the LISTENER pressing play in the service's own app.

So the fixture now does exactly that: ``POST /api/demo/manual-play`` makes
the demo provider's one global speaker play a track outside the run's deck —
the same call path a real listener's manual play takes through the provider.
The run's watcher observes it on its next poll, ``engine.reconcile`` reports
real drift, and the F8 state machine books ``manual_detected``.  Nothing is
mocked: reconcile, watcher, state machine and player all run production code.

The legacy preset's ``manual_use_policy='auto_resume'`` only resumes when the
foreign playback ends or returns to the plan — the simulated manual track
keeps playing, so the drifted state holds exactly like a listener who is
still doing their own thing (the resume/pause buttons remain the way back).
"""

from __future__ import annotations

import pytest

from tests.browser import helpers
from tests.browser.conftest import DESKTOP, write_artifact_json

pytestmark = pytest.mark.browser

#: A library track that belongs to NO demo playlist deck under test
#: (DEMO_PLAYLIST_SMALL = tracks[:12]); playing it is unambiguous drift.
FOREIGN_TRACK = "demo-01000"


def _provoke_takeover(page_a, run_a: int, attempts: int = 6) -> bool:
    """Return True once run A's player shows the takeover state."""
    for _ in range(attempts):
        # The listener presses play in the service's own app (simulated).
        page_a.evaluate(
            """([track]) => fetch('/api/demo/manual-play', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ track_id: track }),
               })""",
            [FOREIGN_TRACK],
        )
        try:
            helpers.wait_for_state_chip(page_a, helpers.STATE_B_TEXT, timeout=9_000)
            return True
        except Exception:
            page_a.wait_for_timeout(1_000)
    return False


def _build_takeover(new_page):
    """One Live run; a simulated manual play on its speaker drifts it."""
    page_a = new_page()
    run_a = helpers.start_live_run(page_a, helpers.DEMO_PLAYLIST_SMALL)

    if not _provoke_takeover(page_a, run_a):
        pytest.fail(
            f"run {run_a} never reported the manual takeover after the demo "
            f"speaker was claimed manually — chip reads "
            f"{page_a.locator('#stateChip').inner_text()!r}"
        )
    return page_a, run_a


@pytest.fixture(scope="module")
def taken_over(browser, demo_storage_state, live_server):
    """Set up the takeover once for the read-only assertions below.

    Module scope on purpose: provoking a real drift costs a dealt run and a
    couple of watcher polls, and the tests that only *read* the resulting
    screen must not each pay for it. The tests that resolve the state use
    ``fresh_takeover`` instead.
    """
    contexts = []

    def new_page():
        context = browser.new_context(
            viewport=DESKTOP, base_url=live_server, storage_state=demo_storage_state
        )
        contexts.append(context)
        return context.new_page()

    yield _build_takeover(new_page)
    for context in reversed(contexts):
        context.close()


@pytest.fixture
def fresh_takeover(context_factory):
    """A takeover of its own, for the tests that resolve it."""
    return _build_takeover(lambda: context_factory().new_page())


def test_takeover_banner_explains_the_state_and_offers_both_ways_out(taken_over, artifact_dir):
    page_a, run_a = taken_over

    chip = page_a.locator("#stateChip").inner_text()
    assert helpers.STATE_B_TEXT in chip, chip
    assert "Demo-Dienst" in chip, f"the chip does not name who took over: {chip!r}"

    banner = page_a.locator("#stateBanner")
    assert banner.is_visible(), "system state B without a banner"
    assert banner.get_attribute("role") in ("status", "alert")
    text = banner.inner_text()
    assert "manuell übernommen" in text, text
    # "Nichts geht verloren" is the promise the whole resumption story rests on.
    assert "Nichts geht verloren" in text, text
    assert "von" in text and "Titeln" in text, f"the banner hides the saved position: {text!r}"

    labels = banner.locator("button").all_inner_texts()
    assert "Hörvorgang fortsetzen" in labels, labels
    assert "Pausiert lassen" in labels, labels

    for name, box in (
        ("resume", banner.locator('button:has-text("Hörvorgang fortsetzen")').bounding_box()),
        ("leave", banner.locator('button:has-text("Pausiert lassen")').bounding_box()),
    ):
        assert box["height"] >= 44, f"{name} button is only {box['height']:.0f}px high"

    page_a.screenshot(path=str(artifact_dir / "player_stateB_takeover_1280.png"), full_page=True)


def test_transport_is_blocked_while_the_service_is_in_charge(taken_over):
    page_a, _run_a = taken_over
    for button in ("#mainBtn", "#nextBtn", "#prevBtn"):
        assert page_a.locator(button).get_attribute("aria-disabled") == "true", (
            f"{button} still offers to move a run the service is driving"
        )
    hint = page_a.locator("#transportHint").inner_text()
    assert "Steuerung liegt gerade bei" in hint, hint


def test_takeover_banner_text_meets_wcag_aa_in_both_themes(taken_over):
    """The takeover banner is the one screen a listener reads under pressure.

    Measured on the real, genuinely drifted player rather than on the
    styleguide specimen, because only the real page proves what the listener
    sees.
    """
    page_a, _run_a = taken_over
    results = []
    problems = []
    for theme in helpers.THEMES:
        helpers.set_theme(page_a, theme)
        page_a.wait_for_timeout(200)
        for selector in ("#stateBanner .banner-title", "#stateBanner .banner-body",
                         "#stateBanner .banner-policy", "#stateChip"):
            data = page_a.eval_on_selector(selector, helpers.JS_EFFECTIVE_COLORS)
            ratio = helpers.contrast_ratio(data["color"], data["background"])
            needed = helpers.required_ratio(helpers.px(data["font_size"]), data["font_weight"])
            results.append({
                "theme": theme, "selector": selector,
                "ratio": round(ratio, 2), "required": needed,
                "color": [round(c, 1) for c in data["color"]],
                "background": [round(c, 1) for c in data["background"]],
                "font": f"{data['font_size']}/{data['font_weight']}",
                "text": data["text"],
            })
            if ratio + 1e-9 < needed:
                problems.append(
                    f"{theme} {selector}: {ratio:.2f}:1 < {needed:.1f}:1 "
                    f"({data['text']!r})"
                )
    write_artifact_json("contrast_takeover_banner.json", results)
    helpers.set_theme(page_a, "dark")
    assert not problems, "takeover banner contrast:\n  " + "\n  ".join(problems)


def test_dashboard_shows_the_takeover_on_the_run_card(taken_over):
    page_a, run_a = taken_over
    page_a.goto("/runs", wait_until="networkidle")
    page_a.wait_for_selector(f'[data-run-id="{run_a}"]')
    page_a.wait_for_function(
        """([id]) => {
             const chip = document.querySelector(`[data-run-id="${id}"] [data-role="systemchip"]`);
             return chip && chip.textContent.includes('Manuell übernommen');
           }""",
        arg=[str(run_a)],
        timeout=20_000,
    )
    card = page_a.locator(f'[data-run-id="{run_a}"]')
    texts = [t.strip() for t in card.locator(".chip").all_text_contents()]
    assert "Manuell übernommen" in texts, texts
    assert any(word in texts for word in helpers.CONTRACT_WORDS), (
        f"the card drops the contract vocabulary while drifted: {texts}"
    )


def test_resume_takes_the_control_back_to_state_a(fresh_takeover):
    page_a, run_a = fresh_takeover
    page_a.click('#stateBanner button:has-text("Hörvorgang fortsetzen")')
    helpers.wait_for_state_chip(page_a, helpers.STATE_A_TEXT, timeout=25_000)
    assert not page_a.locator("#stateBanner").is_visible(), "the banner survived the resume"
    assert page_a.locator("#mainBtn").get_attribute("aria-disabled") == "false"
    assert page_a.locator("#mainBtn").get_attribute("aria-label") == "Pause"

    page_a.goto(f"/runs/{run_a}/verlauf", wait_until="networkidle")
    page_a.wait_for_selector(".event-row")
    events = page_a.locator(".event-row .e-type").all_inner_texts()
    assert "Spotify hat übernommen" in events, (
        f"the takeover is not in the run's history: {events}"
    )


def test_leaving_it_paused_keeps_the_position(fresh_takeover):
    page_a, run_a = fresh_takeover
    before = page_a.locator("#runMeter").get_attribute("aria-valuenow")
    page_a.click('#stateBanner button:has-text("Pausiert lassen")')
    page_a.wait_for_function(
        "() => document.querySelector('#contractChip')?.textContent?.trim() === 'pausiert'",
        timeout=15_000,
    )
    assert page_a.locator("#contractChip").inner_text().strip() == "pausiert"
    after = page_a.locator("#runMeter").get_attribute("aria-valuenow")
    assert after == before, f"pausing moved the cursor ({before} → {after})"


def test_dashboard_holds_several_runs_of_the_same_playlist(context_factory):
    """ADR-001 Auflage 3: several listening states of *one* playlist.

    The product only ever keeps one *live* run per playlist and mode — asking
    for a playlist you already have running resumes it, and "Neu mischen"
    says in as many words that it discards the running one. The dashboard's
    core case is therefore several runs of the same playlist side by side in
    different states, each with its own progress and its own contract word.
    """
    page = context_factory().new_page()
    first = helpers.deal_live_run(page, helpers.DEMO_PLAYLIST_SMALL)
    helpers.press_transport(page)
    helpers.wait_for_state_chip(page, helpers.STATE_A_TEXT)
    second = helpers.deal_live_run(page, helpers.DEMO_PLAYLIST_SMALL)
    assert first != second, "Neu mischen handed back the same run"

    page.goto("/runs", wait_until="networkidle")
    page.wait_for_selector(f'[data-run-id="{second}"]')
    page.wait_for_timeout(800)

    titles = page.locator(".run-card .run-title").all_inner_texts()
    same = [t for t in titles if helpers.DEMO_PLAYLIST_SMALL in t]
    assert len(same) >= 2, f"the dashboard folded the runs together: {titles}"

    words = []
    for run_id in (first, second):
        card = page.locator(f'[data-run-id="{run_id}"]')
        assert card.count() == 1, f"run {run_id} has no card"
        assert card.locator(".mini-meter[role=progressbar]").count() == 1
        chips = [c.strip() for c in card.locator(".chip").all_text_contents()]
        contract = [c for c in chips if c in helpers.CONTRACT_WORDS]
        assert contract, f"run {run_id} card shows no contract word: {chips}"
        words.append(contract[0])
        # Auflage 3: names wrap in full, so the title box may be several lines
        # but must never be clipped.
        title_box = card.locator(".run-title")
        assert title_box.evaluate(
            "(e) => e.scrollWidth <= e.clientWidth + 1"
            "       && getComputedStyle(e).webkitLineClamp === 'none'"
        ), "the run title is clamped or clipped"

    assert words[0] != words[1], (
        f"both cards of the same playlist read {words[0]!r} — the states are indistinguishable"
    )
