"""Application settings loaded from .env via pydantic-settings.

Each streaming connector reads its own credentials from here.  A connector
whose credentials are absent is *listed but disabled* rather than crashing the
app — you can run true-shuffle with only Spotify configured, only Apple Music,
or all three.
"""

import os
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration — values come from environment / .env file."""

    # -- app ---------------------------------------------------------------
    base_url: str = "http://127.0.0.1:8000"
    secret_key: str = "change-me"
    db_path: str = "./data/true_shuffle.db"
    log_level: str = "INFO"

    # -- run behaviour -----------------------------------------------------
    #: ADR-002: how many titles one play command hands to the service as its
    #: uris window.  The service plays through the window on its own; True
    #: Shuffle only speaks up again at the window boundary.  Conservative
    #: default 250 — the documented body limit of PUT /play is unknown (live
    #: measurement LT-13 before raising it).  The pre-ADR-002 name
    #: ``QUEUE_BUFFER_SIZE`` is still read as an alias so existing deployments
    #: do not break.
    context_window_size: int = Field(
        250,
        validation_alias=AliasChoices("context_window_size", "queue_buffer_size"),
    )
    #: Base interval for the server-side playback watcher.
    watcher_poll_seconds: float = 4.0
    #: How often to reconcile a Handoff-Mode deck against listening history.
    #: Services only keep ~50 recent entries, so this has to be well inside the
    #: time it takes to play 50 tracks (~2.5 hours) — a minute is generous.
    history_poll_seconds: float = 60.0
    #: The watcher stops driving a run after this long without playback.
    watcher_idle_timeout_seconds: int = 900

    # -- Spotify (OAuth 2.0 PKCE — public client, no secret) ---------------
    spotify_client_id: str = ""

    # -- Apple Music (MusicKit) -------------------------------------------
    #: Team ID from the Apple Developer account (the JWT "iss").
    apple_team_id: str = ""
    #: Key ID of the MusicKit private key (the JWT "kid").
    apple_key_id: str = ""
    #: Either an inline PEM of the .p8 key or a path to it.
    apple_private_key: str = ""
    apple_private_key_path: str = ""
    #: Developer-token lifetime in days (Apple's maximum is 180).
    apple_token_days: int = 150

    # -- YouTube / YouTube Music (YouTube Data API v3) ---------------------
    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    #: Daily quota units the project is allowed to spend.  Used to warn the
    #: user *before* a large Utility-Mode write silently dies at unit 10 000.
    youtube_daily_quota: int = 10_000

    # -- YouTube Music, unofficial (opt-in, off by default) ----------------
    #: Enables a second YouTube Music connector built on ``ytmusicapi``, a
    #: reverse-engineered client for YouTube's internal API.  It reaches the
    #: library, Liked Music, uploads and listening history that no public API
    #: exposes — and it is unofficial: it can break without notice and its use
    #: is very likely against YouTube's terms.  Off unless deliberately set.
    enable_unofficial_ytmusic: bool = False

    # -- access ------------------------------------------------------------
    # A single shared code, asked for once per browser session. Empty means no
    # gate, which is what local development wants. Set it when the app is
    # reachable from the internet — see app/gate.py for what it does and does
    # not protect.
    access_code: str = ""

    # -- demo --------------------------------------------------------------
    # An in-memory connector so every function can be exercised without any
    # streaming credentials. Off by default; never a claim about a real service.
    enable_demo_provider: bool = False

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    # -- helpers -----------------------------------------------------------

    @property
    def db_abs_path(self) -> Path:
        """Return the database path as an absolute Path, creating parents."""
        p = Path(self.db_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p.resolve()

    @property
    def apple_private_key_pem(self) -> Optional[str]:
        """The MusicKit signing key as PEM text, from inline value or file."""
        if self.apple_private_key.strip():
            # Allow the key to be pasted into .env with literal "\n".
            return self.apple_private_key.replace("\\n", "\n")
        if self.apple_private_key_path.strip():
            path = Path(self.apple_private_key_path).expanduser()
            if path.is_file():
                return path.read_text(encoding="utf-8")
        return None

    def redirect_uri(self, provider_id: str) -> str:
        return f"{self.base_url.rstrip('/')}/auth/{provider_id}/callback"

    def insecure_defaults(self) -> List[str]:
        """Settings that must not survive into anything but local use."""
        problems: List[str] = []
        if self.secret_key in ("", "change-me", "change_me_to_a_random_string"):
            problems.append(
                "SECRET_KEY is still the default — session cookies and stored "
                "tokens are not protected. Set it to a random 32+ char string."
            )
        return problems

    def refuse_to_start_reason(self) -> Optional[str]:
        """SEC-01 (fail closed): the default SECRET_KEY signs the session AND
        derives the token-vault key — anyone can forge a session and walk
        past the ACCESS_CODE gate.  A log line does not stop that; refusing
        to boot does.  Local-only use (localhost base URL, no access code)
        keeps working so development stays friction-free.
        """
        if not self.insecure_defaults():
            return None
        from urllib.parse import urlsplit

        host = (urlsplit(self.base_url).hostname or "").lower()
        local = host in ("127.0.0.1", "localhost", "::1", "testserver", "")
        if self.access_code or not local:
            return (
                "SECRET_KEY ist noch der Default, aber die App ist nicht rein "
                "lokal (BASE_URL/ACCESS_CODE gesetzt) — Start verweigert. "
                "Setze SECRET_KEY auf einen zufälligen Wert mit 32+ Zeichen."
            )
        return None


def _derive_base_url(settings: Settings) -> Settings:
    """On Fly, work out the public URL instead of making someone type it.

    ``BASE_URL`` builds the OAuth redirect URI, and it has to match what is
    registered with Spotify character for character. The app name is chosen at
    launch and is almost never the placeholder in ``fly.toml``, so the single
    most likely way to end up stuck is a BASE_URL that still says
    ``true-shuffle-mvp`` while the app is called something else — and the error
    Spotify returns for that ("INVALID_CLIENT: Invalid redirect URI") does not
    say which side is wrong.

    Fly sets ``FLY_APP_NAME`` in every machine. If it is present and nobody
    set BASE_URL explicitly, the public hostname follows from it. An explicit
    BASE_URL always wins, so a custom domain still works.
    """
    fly_app = os.environ.get("FLY_APP_NAME", "").strip()
    explicit = os.environ.get("BASE_URL", "").strip()
    if fly_app and not explicit:
        settings.base_url = f"https://{fly_app}.fly.dev"
    return settings


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so .env is read only once."""
    return _derive_base_url(Settings())
