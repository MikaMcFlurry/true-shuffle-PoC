"""A shared access code, for the one situation this app was not built for.

``README.md`` is blunt about it: there is no password login, a browser session
*is* the identity, and this should not be exposed to the internet as it stands.
That is the right warning for a local proof of concept — and it stops being
sufficient the moment the thing is deployed so two other people can try it.

Sessions are already isolated from each other: every run and job query is
scoped by owner, and a foreign run is a 404. So the risk of a public URL is not
that testers see each other's decks. It is that *anyone* who finds the URL can
connect their own Spotify account to someone else's server, and that a beta
build with real OAuth tokens in it sits open on the internet.

A shared code fixes exactly that and nothing more. It is deliberately not a
user system:

* one code for everyone, handed out with the link;
* stored in the session, which is already signed with ``SECRET_KEY``;
* compared in constant time, so the code cannot be guessed a character at a
  time from response timings;
* **off unless ``ACCESS_CODE`` is set**, so local development and the test plan
  in ``TESTEN.md`` are untouched.

It is a doorbell, not a lock. It keeps strangers out of a beta. It is not a
substitute for real accounts, and nothing else in this app should start
depending on it.
"""

from __future__ import annotations

import secrets
from urllib.parse import parse_qs

from fastapi import Request
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import get_settings

#: Reachable without the code. `/health` is what the platform polls to decide
#: whether the machine is alive — gating it would make every deploy look dead.
#: `/static` is what the gate page itself is styled with.
_OPEN_PATHS = ("/health", "/zugang", "/static/")

_PAGE = """<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zugang · true-shuffle</title>
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="shopfront">
  <span class="wordmark">
    <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    <span class="wordmark-text">true-shuffle</span>
  </span>
</header>
<div class="opsrail"><span>TON&nbsp;·&nbsp;<b>IMMER ÜBER DEN DIENST</b></span>
<span class="push">GESCHLOSSENE BETA</span></div>
<main class="sheet">
  <section class="section">
    <div class="index"><b>00</b> Zugang</div>
    <div class="body" style="max-width: 46ch">
      <h1>Geschlossene Beta</h1>
      <p class="dim">
        Dieser Server ist noch keine öffentliche App. Den Zugangscode bekommst
        du von der Person, die dir den Link geschickt hat.
      </p>
      {note}
      <form method="post" action="/zugang" class="stack">
        <label class="field">
          <span class="stencil">Zugangscode</span>
          <input type="password" name="code" autocomplete="current-password"
                 autofocus required>
        </label>
        <div class="row">
          <button class="btn btn-primary btn-lg" type="submit">Weiter</button>
        </div>
      </form>
    </div>
  </section>
</main>
</body>
</html>"""

_WRONG = ('<div class="note note-stop"><span class="stencil">Abgelehnt</span>'
          "<span>Dieser Code stimmt nicht.</span></div>")


def access_code() -> str:
    return (get_settings().access_code or "").strip()


def _page(wrong: bool = False) -> HTMLResponse:
    # 401 rather than 200: this is a refusal, and a crawler or a script should
    # be able to tell without parsing German.
    return HTMLResponse(
        _PAGE.format(note=_WRONG if wrong else ""), status_code=401 if wrong else 200
    )


class AccessGate(BaseHTTPMiddleware):
    """Ask for the shared code once per browser session."""

    async def dispatch(self, request: Request, call_next):
        code = access_code()
        if not code:
            return await call_next(request)          # not deployed, not gated

        if request.url.path.startswith(_OPEN_PATHS):
            return await call_next(request)

        if request.session.get("access_ok") is True:
            return await call_next(request)

        # An API call behind the gate gets JSON, not a login page it cannot
        # render — otherwise fetch() reports a confusing parse error.
        if request.url.path.startswith(("/api/", "/export/")):
            from fastapi.responses import JSONResponse
            return JSONResponse(
                {"detail": "Zugangscode nötig. Lade die Seite neu."}, status_code=401
            )

        return _page()


def register(app) -> None:
    """Wire the gate and its two routes."""

    @app.get("/zugang", response_class=HTMLResponse)
    async def gate_page(request: Request):
        if not access_code() or request.session.get("access_ok") is True:
            return RedirectResponse("/", status_code=303)
        return _page()

    @app.post("/zugang")
    async def gate_submit(request: Request):
        # Parsed by hand rather than with request.form(): that needs
        # python-multipart, and one login form is not worth a dependency in a
        # project whose whole point is not having any.
        body = (await request.body()).decode("utf-8", "replace")
        given = parse_qs(body).get("code", [""])[0]
        # Constant time: a plain == leaks the code one character at a time.
        if not secrets.compare_digest(given, access_code()):
            return _page(wrong=True)
        request.session["access_ok"] = True
        return RedirectResponse("/", status_code=303)

    app.add_middleware(AccessGate)
