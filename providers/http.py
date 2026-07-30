"""Shared HTTP plumbing for connectors: retries, rate limits, sequencing.

Every streaming API rate-limits differently but fails the same way, so the
retry policy lives here once instead of in each connector.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

import httpx

from providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderQuotaError,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_RETRIES = 3
_RETRY_STATUS = (500, 502, 503, 504)

#: Player APIs must not be called concurrently for the same account or the
#: provider's queue ends up in a state nobody can predict.  Keyed by
#: ``f"{provider}:{account}"``.
_locks: Dict[str, asyncio.Lock] = {}


def sequential_lock(key: str) -> asyncio.Lock:
    """Return (creating if needed) the per-account serialisation lock."""
    lock = _locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _locks[key] = lock
    return lock


async def request(
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Any] = None,
    data: Optional[Dict[str, Any]] = None,
    expect_json: bool = True,
    provider: str = "provider",
    client: Optional[httpx.AsyncClient] = None,
) -> Any:
    """Send a request with retry/backoff and normalised error mapping.

    Returns parsed JSON (or ``None`` for empty bodies) when *expect_json*,
    otherwise the raw :class:`httpx.Response`.
    """
    last_error: Optional[str] = None

    for attempt in range(1, MAX_RETRIES + 1):
        owns_client = client is None
        active = client or httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        try:
            resp = await active.request(
                method, url, headers=headers, params=params,
                json=json_body, data=data,
            )
        except httpx.HTTPError as exc:
            last_error = str(exc)
            if attempt == MAX_RETRIES:
                raise ProviderError(f"{provider}: network error — {exc}") from exc
            await asyncio.sleep(2 ** (attempt - 1))
            continue
        finally:
            if owns_client:
                await active.aclose()

        if resp.status_code == 429:
            retry_after = _retry_after(resp)
            logger.warning(
                "%s rate-limited (attempt %d/%d), waiting %ss",
                provider, attempt, MAX_RETRIES, retry_after,
            )
            if attempt == MAX_RETRIES:
                raise ProviderQuotaError(
                    f"{provider}: rate limited, retry after {retry_after}s"
                )
            await asyncio.sleep(min(retry_after, 30))
            continue

        if resp.status_code in _RETRY_STATUS and attempt < MAX_RETRIES:
            logger.warning(
                "%s returned %d (attempt %d), retrying",
                provider, resp.status_code, attempt,
            )
            await asyncio.sleep(2 ** (attempt - 1))
            continue

        if resp.status_code in (401, 403):
            raise _auth_error(provider, resp)

        if resp.status_code >= 400:
            raise ProviderError(
                f"{provider}: HTTP {resp.status_code} — {_snippet(resp)}"
            )

        if not expect_json:
            return resp
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            raise ProviderError(f"{provider}: response was not JSON") from exc

    raise ProviderError(f"{provider}: request failed after {MAX_RETRIES} attempts "
                        f"({last_error or 'unknown error'})")


def _retry_after(resp: httpx.Response) -> int:
    raw = resp.headers.get("Retry-After", "2")
    try:
        return max(1, int(float(raw)))
    except ValueError:
        return 2


def _auth_error(provider: str, resp: httpx.Response) -> ProviderError:
    body = _snippet(resp)
    if resp.status_code == 401:
        return ProviderAuthError(f"{provider}: credentials rejected — {body}")
    # 403 on a music API is usually "wrong tier" or "missing scope", and the
    # difference matters a lot to the user, so keep the provider's own words.
    lowered = body.lower()
    if "quota" in lowered or "rate" in lowered:
        return ProviderQuotaError(f"{provider}: quota exceeded — {body}")
    return ProviderError(f"{provider}: refused (403) — {body}")


def _snippet(resp: httpx.Response, limit: int = 300) -> str:
    text = (resp.text or "").strip().replace("\n", " ")
    return text[:limit] or "(empty body)"
