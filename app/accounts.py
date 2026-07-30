"""Bridge between stored provider accounts and live connectors.

Every call site wants the same thing: "give me a usable token for this user on
this service, refreshing it if necessary".  That belongs in one place.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import List, Optional

from app import db
from providers.base import (
    MusicProvider,
    ProviderAuthError,
    TokenBundle,
)
from providers.registry import get_provider

logger = logging.getLogger(__name__)


class AccountNotConnected(ProviderAuthError):
    """The user has not connected this service (or the link was removed)."""


@dataclass
class Session:
    """A connector plus a currently-valid token for one user."""

    user_id: int
    provider: MusicProvider
    token: TokenBundle
    display_name: str = ""
    market: str = ""
    product_tier: str = ""

    @property
    def provider_id(self) -> str:
        return self.provider.capabilities.id


async def open_session(user_id: int, provider_id: str) -> Session:
    """Load credentials for *user_id* on *provider_id*, refreshing if stale."""
    provider = get_provider(provider_id)
    account = await db.get_provider_account(user_id, provider_id)
    if account is None:
        raise AccountNotConnected(
            f"{provider.capabilities.display_name} is not connected for this user"
        )

    token = TokenBundle.from_dict(account["token"])
    if not token.access_token:
        raise AccountNotConnected(
            f"{provider.capabilities.display_name} credentials are empty — reconnect"
        )

    if provider.needs_refresh(token, now=time.time()):
        logger.info("Refreshing %s credentials for user %s", provider_id, user_id)
        token = await provider.refresh(token)
        await db.update_account_token(user_id, provider_id, token.to_dict())

    # Serialise player calls per connected account, not per access token.
    token.extra.setdefault("account_key", f"{user_id}:{provider_id}")

    return Session(
        user_id=user_id,
        provider=provider,
        token=token,
        display_name=account.get("display_name", ""),
        market=account.get("market", ""),
        product_tier=account.get("product_tier", ""),
    )


async def connected_provider_ids(user_id: int) -> List[str]:
    return [a["provider"] for a in await db.list_provider_accounts(user_id)]


async def store_session_token(session: Session) -> None:
    """Persist a token that a connector rotated mid-flight."""
    await db.update_account_token(
        session.user_id, session.provider_id, session.token.to_dict()
    )


async def try_open_session(user_id: int, provider_id: str) -> Optional[Session]:
    try:
        return await open_session(user_id, provider_id)
    except (AccountNotConnected, KeyError):
        return None
