"""WP3-D4 — new frontend flows over the D1–D3 backends, end to end.

Same fixture patterns as ``test_flow_critical.py`` / ``test_takeover_drift.py``
(``tests/browser/conftest.py``, ``tests/browser/helpers.py``): a real
uvicorn, a real Chromium, the demo connector. Every assertion here is a
product claim from WP3-D4, not an implementation detail — if one of these
goes red, the corresponding feature stopped working for a real listener.
"""

from __future__ import annotations

import re
import uuid

import pytest

from tests.browser import helpers

pytestmark = pytest.mark.browser


# ---------------------------------------------------------------------------
# 1. Config im Builder anlegen → Run mit Config starten (Direktstart mit
#    config_id, RUN-05 preflight, "Als Konfiguration speichern").
# ---------------------------------------------------------------------------

def test_saving_a_config_in_the_builder_starts_the_run_bound_to_it(page):
    page.goto("/library", wait_until="networkidle")
    helpers.release_playing_slot(page)
    page.wait_for_selector("button.record")
    page.click('#modeCards button:has-text("Live")')
    page.click(f'button.record:has-text("{helpers.DEMO_PLAYLIST_SMALL}")')
    page.select_option("#reshuffle", "1")

    # "Begrenzte Wiederholungen" is real now (WP3-D4): pick it, raise the
    # quota a little above its 0 % default so it never collides with the
    # RUN-05 quota_zero_limited conflict on the small demo playlist.
    page.check("#r-limited")
    page.wait_for_timeout(150)
    for _ in range(3):
        page.click("#quotaPlus")
    page.wait_for_timeout(400)  # debounced preflight settles

    config_name = f"Browser-Test {uuid.uuid4().hex[:8]}"
    page.fill("#configSaveName", config_name)
    page.click("#saveConfigBtn")
    page.wait_for_function(
        "([n]) => (document.querySelector('#saveConfigNote')?.textContent || '').includes(n)",
        arg=[config_name],
        timeout=10_000,
    )

    # The picker now carries the freshly saved config (Direktstart), and the
    # rule inputs lock — a listener can see, not silently edit, what it does.
    picker_value = page.eval_on_selector("#configPicker", "(e) => e.value")
    assert picker_value, "saving a config did not select it in the picker"
    assert page.eval_on_selector("#r-limited", "(e) => e.disabled") is True

    page.wait_for_function(
        "document.querySelector('#dealBtn')?.getAttribute('aria-disabled') === 'false'",
        timeout=15_000,
    )
    page.click("#dealBtn")
    page.wait_for_url(re.compile(r"/player/\d+$"), timeout=45_000)
    run_id = int(page.url.rstrip("/").rsplit("/", 1)[-1])

    configs = page.evaluate("() => fetch('/api/configs').then((r) => r.json())")["configs"]
    saved = next(c for c in configs if c["name"] == config_name)
    assert saved["rules"]["repeat_mode"] == "limited_repeat"
    assert saved["rules"]["repeat_quota_pct"] == 35  # 20 default + 3 x 5-step clicks
    assert saved["used_by_runs"] == 1, "the run never bound to the saved config"

    runs = page.evaluate("() => fetch('/api/runs').then((r) => r.json())")["runs"]
    mine = next(r for r in runs if r["id"] == run_id)
    assert mine["config_id"] == saved["id"], (
        f"run {run_id} started with config_id={mine['config_id']}, "
        f"expected the saved config {saved['id']}"
    )


# ---------------------------------------------------------------------------
# 2. Titel im Player ausschließen → verschwindet aus "Als Nächstes"
#    (UC-20, sofortiger Replan, RUN-08).
# ---------------------------------------------------------------------------

def test_excluding_a_track_in_the_player_removes_it_from_up_next(page):
    helpers.start_live_run(page, helpers.DEMO_PLAYLIST_SMALL)
    page.wait_for_selector("#upnext li .u-name")

    first_row = page.locator("#upnext li").first
    excluded_name = first_row.locator(".u-name").inner_text()
    exclude_btn = first_row.locator('button[aria-label^="Titel ausschließen"]')
    assert exclude_btn.count() == 1, "the D3 exclude icon is missing from the up-next row"

    exclude_btn.click()
    page.wait_for_function(
        "() => (document.querySelector('#playerNote')?.textContent || '')"
        ".toLowerCase().includes('ausgeschlossen')",
        timeout=10_000,
    )
    # The stencil label is upper-cased by CSS (text-transform), so compare
    # case-insensitively rather than assert on the exact rendered case.
    assert "ausgeschlossen" in page.locator("#playerNote").inner_text().lower()

    remaining = page.locator("#upnext li .u-name").all_inner_texts()
    assert excluded_name not in remaining, (
        f"„{excluded_name}“ excluded but still listed in Als Nächstes: {remaining}"
    )


# ---------------------------------------------------------------------------
# 3. Config duplizieren auf configs-Seite (UC-28).
# ---------------------------------------------------------------------------

def test_duplicating_a_config_on_the_configs_page(page):
    source_name = f"Original {uuid.uuid4().hex[:8]}"
    page.goto("/library", wait_until="networkidle")
    page.evaluate(
        """([name]) => fetch('/api/configs', {
             method: 'POST', headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ name, rules: { skip_policy: 'keep_open' } }),
           })""",
        [source_name],
    )

    # :text-is() for an EXACT match — "has-text" is substring, and the copy's
    # own name literally contains the source name as a prefix ("… (Kopie)").
    page.goto("/konfigurationen", wait_until="networkidle")
    card = page.locator(".card", has=page.locator(f'h2:text-is("{source_name}")'))
    card.wait_for(timeout=10_000)
    card.locator('button:has-text("Duplizieren")').click()

    copy_name = f"{source_name} (Kopie)"
    page.wait_for_function(
        "([n]) => [...document.querySelectorAll('#configGrid h2')]"
        ".some((h) => h.textContent.trim() === n)",
        arg=[copy_name],
        timeout=10_000,
    )
    copy_card = page.locator(".card", has=page.locator(f'h2:text-is("{copy_name}")'))
    assert copy_card.count() == 1
    assert "Dupliziert" in copy_card.inner_text()
    # The source config is untouched, still on the page as its own card.
    assert page.locator(".card", has=page.locator(f'h2:text-is("{source_name}")')).count() == 1

    configs = page.evaluate("() => fetch('/api/configs').then((r) => r.json())")["configs"]
    names = [c["name"] for c in configs]
    assert source_name in names and copy_name in names


# ---------------------------------------------------------------------------
# 4. Verlauf zeigt Tracknamen (WP3-D4: db.list_events LEFT JOIN run_tracks →
#    tracks — real names instead of only the cursor position).
# ---------------------------------------------------------------------------

def test_history_shows_real_track_names_not_only_positions(page):
    run_id = helpers.start_live_run(page, helpers.DEMO_PLAYLIST_SMALL)
    for _ in range(3):
        page.evaluate(
            """([id]) => fetch(`/api/runs/${id}/advance`, {
                 method: 'POST', headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ reason: 'user_skip' }),
               })""",
            [run_id],
        )
        page.wait_for_timeout(150)

    page.goto(f"/runs/{run_id}/verlauf", wait_until="networkidle")
    page.wait_for_selector(".event-row")

    rows = page.locator(".event-row")
    advanced_details = [
        rows.nth(i).locator(".e-detail").inner_text()
        for i in range(rows.count())
        if "Weitergerückt" in rows.nth(i).locator(".e-type").inner_text()
    ]
    assert advanced_details, "no 'Weitergerückt' rows to check"
    # Demo tracks are named "Titel — Interpret" (providers/demo.py); a real
    # name resolves to that shape, the honest fallback never contains "—".
    named = [d for d in advanced_details if "—" in d]
    assert named, (
        f"none of the advance events resolved a real track name, "
        f"still showing only cursor positions: {advanced_details}"
    )
    for detail in named:
        assert "Titel " not in detail.split("·")[-1], detail
