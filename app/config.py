"""Application settings loaded from .env via pydantic-settings."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration — values come from environment / .env file."""

    # Spotify
    spotify_client_id: str = ""

    # App
    base_url: str = "http://localhost:8000"
    secret_key: str = "change-me"

    # Database
    db_path: str = "./data/true_shuffle.db"

    # Controller Mode
    queue_buffer_size: int = 5

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @property
    def db_abs_path(self) -> Path:
        """Return the database path as an absolute Path, creating parents if needed."""
        p = Path(self.db_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p.resolve()


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so .env is read only once."""
    return Settings()
