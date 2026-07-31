"""Fixtures for the browser suite: a throwaway server and a real Chromium.

Design rules this file follows, and why
======================================

**The repository's own ``.env`` is never touched.** The server runs as a
subprocess with an explicit environment: its own random ``SECRET_KEY``, its
own database inside pytest's tmp dir, and ``ENABLE_DEMO_PROVIDER=true`` so the
whole product can be exercised without any streaming credentials. Environment
variables outrank ``.env`` in pydantic-settings, so the developer's local
configuration survives a test run unchanged.

**Nothing here runs unless a browser is actually present.** Playwright and its
Chromium are optional extras (``requirements-optional.txt``); a checkout
without them must still go green on ``python -m pytest -q``. So this module
imports Playwright defensively, and, if anything is missing, marks every test
below ``tests/browser/`` as skipped instead of erroring. Test modules import
only ``helpers.py``, which has no Playwright import at all — collection
therefore always succeeds.

**The demo device is a single global simulation.** ``providers/demo.py`` is
one module-level instance with one simulated speaker shared by every run in
the process, which is exactly what makes the manual-takeover scenario real:
starting a second Live run *is* "somebody started something else on the
speaker". The flip side is that a test which needs system state A has to
create and start its own run right before it asserts, rather than trusting a
run some earlier test started. ``live_run`` does that; ``dealt_run`` is the
cheap session-scoped run for tests that only need a player page to exist.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.browser import helpers

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_DIR = Path(__file__).parent / "artifacts"

HOST = "127.0.0.1"
PORT = int(os.environ.get("TS_BROWSER_PORT", "8765"))
BASE_URL = f"http://{HOST}:{PORT}"

DESKTOP = {"width": 1280, "height": 900}

#: Where the pinned Chromium lives in this environment. The unversioned
#: ``chromium`` symlink is tried first so a browser upgrade does not need a
#: code change; the versioned paths are the fallback for installs that only
#: unpack the revision directory.
CHROMIUM_CANDIDATES = (
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
)


def _find_chromium() -> str | None:
    """The browser to drive, or None — which turns the whole suite into skips.

    ``TS_CHROMIUM_PATH`` overrides *exclusively*: if someone names a binary,
    a silent fall back to a different one would run the suite against a
    browser they did not choose, and would also make the "no browser" path
    untestable on a machine that happens to have one.
    """
    override = os.environ.get("TS_CHROMIUM_PATH", "").strip()
    if override:
        return override if Path(override).exists() else None

    for candidate in CHROMIUM_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    # Last resort: a Chromium on PATH (developer machines, CI images).
    for name in ("chromium", "chromium-browser", "google-chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _unavailable_reason() -> str | None:
    try:
        import playwright.sync_api  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on the machine
        return f"playwright is not installed ({exc})"
    if _find_chromium() is None:
        return (
            "no Chromium binary found — set TS_CHROMIUM_PATH or run "
            "`python -m playwright install chromium`"
        )
    return None


SKIP_REASON = _unavailable_reason()
CHROMIUM_PATH = _find_chromium()

_HERE = Path(__file__).parent


def pytest_collection_modifyitems(config, items):
    """Mark the whole browser suite skipped when there is no browser.

    Done here rather than with ``collect_ignore`` on purpose: a skip is
    visible in the summary, a silently ignored directory is not.
    """
    if not SKIP_REASON:
        return
    skip = pytest.mark.skip(reason=SKIP_REASON)
    for item in items:
        if _HERE in Path(str(item.path)).parents:
            item.add_marker(skip)


# ---------------------------------------------------------------------------
# The server under test
# ---------------------------------------------------------------------------

def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HOST, port))
        except OSError:
            return False
    return True


def _wait_until_up(url: str, process: subprocess.Popen, log: Path, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            tail = log.read_text(errors="replace")[-4000:]
            raise RuntimeError(f"uvicorn exited with {process.returncode}\n{tail}")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = exc
        time.sleep(0.25)
    raise RuntimeError(
        f"server did not answer on {url} within {timeout}s (last: {last})\n"
        f"{log.read_text(errors='replace')[-4000:]}"
    )


@pytest.fixture(scope="session")
def live_server(tmp_path_factory) -> str:
    """A real uvicorn on :8765 with the demo connector and a throwaway DB."""
    if not _port_is_free(PORT):
        pytest.fail(
            f"port {PORT} is already in use — stop the other server or set "
            f"TS_BROWSER_PORT to something free."
        )

    workdir = tmp_path_factory.mktemp("browser-server")
    log_path = workdir / "uvicorn.log"

    env = dict(os.environ)
    env.update(
        ENABLE_DEMO_PROVIDER="true",
        SECRET_KEY=secrets.token_urlsafe(32),
        DB_PATH=str(workdir / "browser-suite.db"),
        BASE_URL=BASE_URL,
        # The watcher's poll interval is how fast a takeover becomes visible;
        # 4s (the product default) would make the drift test wait a minute.
        WATCHER_POLL_SECONDS="1.0",
        LOG_LEVEL="WARNING",
        # No shared access code in front of the suite, whatever the checkout has.
        ACCESS_CODE="",
        PYTHONUNBUFFERED="1",
    )
    # A stale FLY_APP_NAME would rewrite BASE_URL out from under the redirects.
    env.pop("FLY_APP_NAME", None)

    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app",
             "--host", HOST, "--port", str(PORT), "--log-level", "warning"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        try:
            _wait_until_up(f"{BASE_URL}/", process, log_path)
            yield BASE_URL
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover
                process.kill()
                process.wait(timeout=5)


# ---------------------------------------------------------------------------
# Browser, session identity, pages
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def browser(live_server):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(
            executable_path=CHROMIUM_PATH,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            yield instance
        finally:
            instance.close()


@pytest.fixture(scope="session")
def demo_storage_state(browser, live_server):
    """Connect the demo service once; every context reuses that identity.

    Identity in this app *is* the session cookie (``app/deps.py``): a fresh
    context is a different anonymous user and cannot see the other's runs, so
    sharing the storage state is what makes cross-context tests possible.
    """
    context = browser.new_context(viewport=DESKTOP, base_url=live_server)
    page = context.new_page()
    helpers.connect_demo(page)
    assert "/library" in page.url or "/connect" in page.url, page.url
    state = context.storage_state()
    context.close()
    return state


@pytest.fixture
def context_factory(browser, demo_storage_state, live_server):
    """Make contexts that are already signed in, and close them afterwards."""
    made = []

    def make(viewport=None, **kwargs):
        context = browser.new_context(
            viewport=dict(viewport or DESKTOP),
            base_url=live_server,
            storage_state=demo_storage_state,
            **kwargs,
        )
        made.append(context)
        return context

    yield make
    for context in reversed(made):
        # Teardown is best effort: a context whose browser already died must
        # not turn a passing test red.
        with contextlib.suppress(Exception):  # pragma: no cover
            context.close()


@pytest.fixture
def page(context_factory):
    """A desktop page, signed in, with console errors surfaced on failure."""
    page = context_factory().new_page()
    errors: list[str] = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.console_errors = errors  # read by tests that care
    return page


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def dealt_run(browser, demo_storage_state, live_server) -> int:
    """One Live run over the 1 482-track demo playlist, dealt but not started.

    Read-only tests (structure, touch targets, overflow, contrast, themes)
    only need a player page that renders, and they need it to stay dealt for
    the whole session. It uses the *large* playlist on purpose: no other
    fixture touches that one, so no later "Neu mischen" can cancel it out
    from under a test, and every measured page is carrying a realistic amount
    of content while it is measured.
    """
    context = browser.new_context(
        viewport=DESKTOP, base_url=live_server, storage_state=demo_storage_state
    )
    page = context.new_page()
    run_id = helpers.deal_live_run(page, helpers.DEMO_PLAYLIST_LARGE)
    context.close()
    return run_id


@pytest.fixture
def live_run(page) -> int:
    """A freshly dealt Live run, started, confirmed in system state A.

    Created per test because the demo speaker is global: the newest started
    run is the one that owns it.
    """
    return helpers.start_live_run(page)


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def artifact_dir() -> Path:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    return ARTIFACT_DIR


def write_artifact_json(name: str, payload) -> Path:
    """Persist a machine-readable finding next to the screenshots."""
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / name
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path
