"""Streaming-service connectors.

Every service true-shuffle can talk to implements :class:`~providers.base.MusicProvider`.
The rest of the application never imports a concrete provider directly — it
resolves one through :mod:`providers.registry`.
"""

from providers.base import (  # noqa: F401
    AuthKind,
    AuthStart,
    MusicProvider,
    PlaybackControl,
    ProviderAuthError,
    ProviderCapabilities,
    ProviderError,
    ProviderNotConfigured,
    ProviderQuotaError,
    TokenBundle,
    Unsupported,
)
from providers.registry import (  # noqa: F401
    all_providers,
    configured_providers,
    get_provider,
)
