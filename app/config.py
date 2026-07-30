"""Application settings loaded from .env via pydantic-settings.

Each streaming connector reads its own credentials from here.  A connector
whose credentials are absent is *listed but disabled* rather than crashing the
app — you can run true-shuffle with only Spotify configured, only Apple Music,
or all three.
"""

from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration — values come from environment / .env file."""

    # -- app ---------------------------------------------------------------
    base_url: str = "http://127.0.0.1:8000"
    secret_key: str = "change-me"
    db_path: str = "./data/true_shuffle.db"
    log_level: str = "INFO"

    # -- run behaviour -----------------------------------------------------
    #: How many upcoming tracks to push into a provider queue ahead of time.
    queue_buffer_size: int = 5
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


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so .env is read only once."""
    return Settings()
