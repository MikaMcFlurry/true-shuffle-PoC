"""Connector registry — the only place that knows which services exist."""

from __future__ import annotations

from typing import Dict, List, Optional

from providers.apple import AppleMusicProvider
from providers.base import MusicProvider, ProviderNotConfigured
from providers.demo import DemoProvider
from providers.spotify import SpotifyProvider
from providers.youtube import YouTubeMusicProvider
from providers.ytmusic_unofficial import UnofficialYouTubeMusicProvider

#: Order matters — this is the order the connect screen shows them in.
_PROVIDERS: Dict[str, MusicProvider] = {
    "spotify": SpotifyProvider(),
    "apple": AppleMusicProvider(),
    "youtube": YouTubeMusicProvider(),
    # Opt-in and last: unofficial, and never the default path to YouTube Music.
    "ytmusic": UnofficialYouTubeMusicProvider(),
    # Opt-in, and never mistakable for a real service.
    "demo": DemoProvider(),
}


def all_providers() -> List[MusicProvider]:
    """Every connector that ships with this build, configured or not."""
    return list(_PROVIDERS.values())


def configured_providers() -> List[MusicProvider]:
    """Connectors the operator has supplied credentials for."""
    return [p for p in _PROVIDERS.values() if p.is_configured()]


def get_provider(provider_id: str, *, require_configured: bool = True) -> MusicProvider:
    """Resolve a connector by id.

    Raises ``KeyError`` for an unknown id and
    :class:`~providers.base.ProviderNotConfigured` when credentials are absent
    — the two failures mean very different things to the caller.
    """
    provider = _PROVIDERS.get(provider_id)
    if provider is None:
        raise KeyError(provider_id)
    if require_configured and not provider.is_configured():
        raise ProviderNotConfigured(
            f"{provider.capabilities.display_name} is not configured — set "
            + ", ".join(provider.missing_config())
        )
    return provider


def try_get_provider(provider_id: str) -> Optional[MusicProvider]:
    return _PROVIDERS.get(provider_id)
