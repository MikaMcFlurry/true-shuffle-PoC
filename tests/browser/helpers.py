"""Page-driving helpers, JS probes and WCAG maths for the browser suite.

Nothing in this module imports Playwright. That is deliberate: the test
modules import it at collection time, and collection has to survive on a
machine that has no browser installed (see ``conftest.py``). Every function
here takes an already-created Playwright ``Page`` and only duck-types it.

The German strings are the product's own copy — asserting on them is the
point, since "the interface says which system is in charge" is an acceptance
criterion, not an implementation detail.
"""

from __future__ import annotations

import re
from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# The eight pages the acceptance report covers
# ---------------------------------------------------------------------------

#: (name, path template). ``{run}`` is filled with a real run id.
PAGES: List[Tuple[str, str]] = [
    ("home", "/"),
    ("connect", "/connect"),
    ("library", "/library"),
    ("runs", "/runs"),
    ("player", "/player/{run}"),
    ("verlauf", "/runs/{run}/verlauf"),
    ("konfigurationen", "/konfigurationen"),
    ("styleguide", "/styleguide"),
]

#: Widths the work package fixes for the visual acceptance.
VIEWPORTS: Dict[str, Dict[str, int]] = {
    "320": {"width": 320, "height": 900},
    "390": {"width": 390, "height": 900},
    "768": {"width": 768, "height": 1024},
    "1280": {"width": 1280, "height": 900},
}

THEMES = ("dark", "light")

#: What the player writes into #stateChip for the four system states. Only
#: A, B and D have a producer in this phase (player.js ``_deriveSystemState``).
STATE_A_TEXT = "True Shuffle steuert"
STATE_B_TEXT = "manuell übernommen"
STATE_D_TEXT = "Kein aktives Gerät"

#: The contract vocabulary ADR-001 Auflage 5 requires on every run card.
CONTRACT_WORDS = ("aktiv", "pausiert", "abgeschlossen", "beendet")

DEMO_PLAYLIST_SMALL = "Kurzes Fach (Demo)"
DEMO_PLAYLIST_DIRTY = "Mit Ausschuss (Demo)"
#: 1 482 tracks — the size PRODUCT.md says the real listener has.
DEMO_PLAYLIST_LARGE = "Alles (Demo)"


# ---------------------------------------------------------------------------
# Flow helpers
# ---------------------------------------------------------------------------

def connect_demo(page) -> None:
    """Attach the demo connector to this browser session through the UI."""
    page.goto("/connect", wait_until="networkidle")
    page.click('a[href="/auth/demo/login"]')
    page.wait_for_load_state("networkidle")


def release_playing_slot(page) -> None:
    """Pause whatever run currently holds the one-playing slot (WP3-D3).

    Since schema v3, ``idx_runs_one_playing`` allows at most ONE actively
    playing controller run per account (SP-003: two runs cannot drive one
    device).  Every test in this suite shares one demo account, so a run an
    earlier test left active would make the next dealt run start 'paused'
    and the next start answer 409 — exactly the sentence the product gives a
    real listener: „stoppe oder pausiere ihn zuerst".  This helper does that
    listener's step with the product's own pause endpoint, nothing else.
    """
    page.evaluate(
        """async () => {
             const res = await fetch('/api/runs');
             if (!res.ok) return;
             const { runs } = await res.json();
             for (const r of runs) {
               if (r.status === 'active' && r.mode === 'controller') {
                 await fetch(`/api/runs/${r.id}/pause`, { method: 'POST' });
               }
             }
           }"""
    )


def deal_live_run(page, playlist: str = DEMO_PLAYLIST_SMALL, *, fresh: bool = True) -> int:
    """Walk /library the way a listener does and return the run's id.

    Three product behaviours make this less obvious than it looks, and all
    are deliberate in the app:

    * Live Mode has to be chosen explicitly. Handoff needs nothing open and is
      what the mode list offers first, so a test that just presses "start"
      would silently assert against Handoff.
    * Asking for a playlist that already has a live run *resumes* it
      ("Wiederaufnahme ist ein Hauptfall"). ``fresh=True`` therefore picks
      "Neu mischen", which is the UI's own way to say "deal again" — without
      it a second call would hand back the first run, in whatever state an
      earlier test left it.
    * At most one actively playing controller run per account (SP-003, v3):
      the slot is released first — see :func:`release_playing_slot` — so the
      new deck deals 'aktiv'/"Bereit" instead of being born paused behind a
      run some earlier test left running.
    """
    page.goto("/library", wait_until="networkidle")
    release_playing_slot(page)
    page.wait_for_selector("button.record")
    page.click('#modeCards button:has-text("Live")')
    page.click(f'button.record:has-text("{playlist}")')
    page.select_option("#reshuffle", "1" if fresh else "0")
    page.wait_for_function(
        "document.querySelector('#dealBtn')?.getAttribute('aria-disabled') === 'false'",
        timeout=15_000,
    )
    page.click("#dealBtn")
    page.wait_for_url(re.compile(r"/player/\d+$"), timeout=45_000)
    # The player is booted once it has replaced the contract chip placeholder.
    page.wait_for_function(
        "() => { const c = document.querySelector('#contractChip');"
        "        return c && c.textContent.trim() && c.textContent.trim() !== '…'; }",
        timeout=20_000,
    )
    return int(page.url.rstrip("/").rsplit("/", 1)[-1])


def press_transport(page) -> None:
    """Press the main transport button once, guarding against the disabled state."""
    page.wait_for_function(
        "document.querySelector('#mainBtn')?.getAttribute('aria-disabled') === 'false'",
        timeout=15_000,
    )
    page.click("#mainBtn")


def wait_for_state_chip(page, text: str, timeout: int = 25_000) -> None:
    """Wait until a **visible** #stateChip carries ``text``.

    The visibility check matters: the player hides the chip rather than
    emptying it, so the old state's words stay in ``textContent`` and a
    text-only wait would return immediately with a stale answer.
    """
    page.wait_for_function(
        """([t]) => {
             const chip = document.querySelector('#stateChip');
             return !!chip && chip.getClientRects().length > 0
                    && chip.textContent.includes(t);
           }""",
        arg=[text],
        timeout=timeout,
    )


def start_live_run(page, playlist: str = DEMO_PLAYLIST_SMALL) -> int:
    """Deal a Live run, start it, and wait until system state A is on screen."""
    run_id = deal_live_run(page, playlist)
    press_transport(page)
    wait_for_state_chip(page, STATE_A_TEXT)
    return run_id


def visible_state_chip(page) -> str:
    """The system-state chip's text, or "" while the chip is hidden.

    ``inner_text`` on a ``display:none`` element falls back to its text
    content, so a hidden chip would otherwise keep reporting the last state
    it showed — which is exactly the assertion mistake this avoids.
    """
    chip = page.locator("#stateChip")
    if chip.count() == 0 or not chip.is_visible():
        return ""
    return chip.inner_text().strip()


def set_theme(page, theme: str) -> None:
    page.evaluate("([t]) => { document.documentElement.dataset.theme = t; }", [theme])
    page.wait_for_timeout(120)


# ---------------------------------------------------------------------------
# JS probes
# ---------------------------------------------------------------------------

#: Every element a pointer or the keyboard can reach, with the *effective*
#: target box. WCAG measures the region that activates the control, so a
#: radio inside (or bound to) a label is measured as that label — which is
#: what a finger actually hits.
JS_INTERACTIVE_TARGETS = """
() => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary,'
            + ' [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const out = [];
  for (const e of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let lab = e.closest('label');
    if (!lab && e.id) {
      try { lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); }
      catch (_) { /* an id CSS.escape cannot express is not a label target */ }
    }
    const lr = lab ? lab.getBoundingClientRect() : null;
    out.push({
      tag: e.tagName,
      id: e.id || '',
      cls: String(e.className || '').slice(0, 60),
      width: +r.width.toFixed(1),
      height: +r.height.toFixed(1),
      effective_width: +(lr ? Math.max(r.width, lr.width) : r.width).toFixed(1),
      effective_height: +(lr ? Math.max(r.height, lr.height) : r.height).toFixed(1),
      label_width: lr ? +lr.width.toFixed(1) : null,
      label_height: lr ? +lr.height.toFixed(1) : null,
      native_disabled: e.disabled === true,
      aria_disabled: e.getAttribute('aria-disabled'),
      name: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 48),
    });
  }
  return out;
}
"""

#: Landmarks, headings, nav state and meters — the structural acceptance.
JS_PAGE_STRUCTURE = """
() => {
  const txt = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim();
  return {
    main_count: document.querySelectorAll('main').length,
    main_inhalt_count: document.querySelectorAll('main#inhalt').length,
    h1: [...document.querySelectorAll('h1')].map(txt),
    aria_current: [...document.querySelectorAll('.appnav [aria-current]')]
        .map((a) => ({ href: a.getAttribute('href'), value: a.getAttribute('aria-current') })),
    nav_links: [...document.querySelectorAll('.appnav a')].map((a) => a.getAttribute('href')),
    skip_link: (() => {
      const a = document.querySelector('a.skip-link');
      return a ? { href: a.getAttribute('href'), text: txt(a) } : null;
    })(),
    meters: [...document.querySelectorAll('.mini-meter, .meter, .job-bar, progress')].map((e) => ({
      cls: String(e.className || '').slice(0, 40),
      role: e.getAttribute('role'),
      valuenow: e.getAttribute('aria-valuenow'),
      valuemin: e.getAttribute('aria-valuemin'),
      valuemax: e.getAttribute('aria-valuemax'),
      label: e.getAttribute('aria-label'),
    })),
    chips: [...document.querySelectorAll('.chip')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ cls: String(e.className || ''), text: txt(e) })),
    lang: document.documentElement.getAttribute('lang'),
  };
}
"""

#: Composites every ancestor background down to the page, so a transparent
#: chip is measured against what is really behind it.
JS_EFFECTIVE_COLORS = """
(el) => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  // page backstop: html/body background, else white
  const layers = [];
  let n = el;
  let opacity = 1;
  while (n && n.nodeType === 1) {
    const cs = getComputedStyle(n);
    const c = parse(cs.backgroundColor);
    if (c && c.a > 0) layers.push(c);
    const o = parseFloat(cs.opacity);
    if (!Number.isNaN(o)) opacity *= o;
    n = n.parentElement;
  }
  layers.push({ r: 255, g: 255, b: 255, a: 1 });
  let bg = layers[layers.length - 1];
  for (let i = layers.length - 2; i >= 0; i--) bg = over(layers[i], bg);

  const cs = getComputedStyle(el);
  let fg = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
  // Element opacity fades the glyphs against their own background.
  fg = { ...fg, a: fg.a * opacity };
  const composited = over(fg, bg);

  return {
    color: [composited.r, composited.g, composited.b],
    background: [bg.r, bg.g, bg.b],
    raw_color: cs.color,
    font_size: cs.fontSize,
    font_weight: cs.fontWeight,
    opacity: opacity,
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
  };
}
"""

#: Anything still moving. ``getAnimations()`` reports CSS animations *and*
#: transitions, so a page that only fades still shows up here.
JS_RUNNING_ANIMATIONS = """
() => document.getAnimations()
    .filter((a) => a.playState === 'running')
    .map((a) => ({
      state: a.playState,
      name: a.animationName || a.transitionProperty || 'unknown',
      target: a.effect && a.effect.target
        ? a.effect.target.tagName + '.'
          + String(a.effect.target.className || '').slice(0, 30)
        : '?',
    }))
"""

JS_HORIZONTAL_OVERFLOW = """
() => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const culprits = [];
  if (de.scrollWidth > cw) {
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > cw + 1 || r.left < -1) {
        culprits.push({
          tag: e.tagName, cls: String(e.className || '').slice(0, 40),
          left: Math.round(r.left), right: Math.round(r.right),
        });
      }
    }
  }
  return { scroll_width: de.scrollWidth, client_width: cw, culprits: culprits.slice(0, 12) };
}
"""

JS_ACTIVE_ELEMENT = """
() => {
  const e = document.activeElement;
  if (!e || e === document.body) {
    return { tag: e ? e.tagName : null, id: '', cls: '', text: '', is_body: true };
  }
  const cs = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  const all = [...document.querySelectorAll('*')];
  return {
    dom_index: all.indexOf(e),
    tabindex: e.getAttribute('tabindex'),
    left: Math.round(r.left),
    tag: e.tagName,
    id: e.id || '',
    cls: String(e.className || '').slice(0, 60),
    text: (e.getAttribute('aria-label') || e.textContent || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 48),
    href: e.getAttribute ? (e.getAttribute('href') || '') : '',
    outline_width: cs.outlineWidth,
    outline_style: cs.outlineStyle,
    outline_color: cs.outlineColor,
    outline_offset: cs.outlineOffset,
    box_shadow: String(cs.boxShadow).slice(0, 120),
    top: Math.round(r.top),
    height: Math.round(r.height),
    is_body: false,
  };
}
"""


def tab_walk(page, steps: int = 40) -> List[dict]:
    """Press Tab ``steps`` times and record what is focused after each press."""
    page.evaluate("() => { document.body.focus(); }")
    seen: List[dict] = []
    for _ in range(steps):
        page.keyboard.press("Tab")
        info = page.evaluate(JS_ACTIVE_ELEMENT)
        if info.get("is_body"):
            break
        seen.append(info)
    return seen


def describe(node: dict) -> str:
    """A short, stable identity for a focused/measured node."""
    ident = node.get("id") or (node.get("cls") or "").split(" ")[0]
    return f"{node.get('tag', '?')}#{ident or '-'}"


# ---------------------------------------------------------------------------
# WCAG 2.x contrast maths (§1.4.3) — deliberately hand-rolled so the suite
# has no extra dependency and the numbers in the report can be recomputed.
# ---------------------------------------------------------------------------

def _channel(value: float) -> float:
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb) -> float:
    r, g, b = (_channel(float(v)) for v in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(rgb_a, rgb_b) -> float:
    la, lb = relative_luminance(rgb_a), relative_luminance(rgb_b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def required_ratio(font_size_px: float, font_weight: str) -> float:
    """WCAG AA: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5."""
    try:
        weight = int(font_weight)
    except (TypeError, ValueError):
        weight = 700 if str(font_weight) in ("bold", "bolder") else 400
    if font_size_px >= 24.0 or (font_size_px >= 18.66 and weight >= 700):
        return 3.0
    return 4.5


def px(value: str) -> float:
    return float(str(value).replace("px", "").strip() or 0)
