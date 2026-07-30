"""Shared HTTP plumbing for connectors: retries, rate limits, sequencing.

Every streaming API rate-limits differently but fails the same way, so the
retry policy lives here once instead of in each connector.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

import httpx

from providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderPaidTierRequired,
    ProviderQuotaError,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_RETRIES = 3
_RETRY_STATUS = (500, 502, 503, 504)

#: Spotify's July 2026 body for "you are out of quota", as opposed to "you are
#: going too fast".  The distinction matters: the second is worth waiting out,
#: the first is not, and burning three retries on it only makes the hole deeper.
QUOTA_REASONS = frozenset({"QUOTA_EXCEEDED"})

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


# ---------------------------------------------------------------------------
# Throttling
# ---------------------------------------------------------------------------

#: Minimum seconds between two requests on the same throttle key, and the time
#: the last one went out.  A plain spacer, not a token bucket: the point is to
#: stop a burst of single-item lookups from arriving as a burst, and a bucket
#: would happily let the whole burst through and only then start refusing.
_throttle_interval: Dict[str, float] = {}
_throttle_last: Dict[str, float] = {}
_throttle_locks: Dict[str, asyncio.Lock] = {}


def set_throttle(key: str, min_interval: float) -> None:
    """Space requests on *key* at least *min_interval* seconds apart."""
    _throttle_interval[key] = max(0.0, min_interval)


async def throttle(key: str) -> None:
    """Wait until the next request on *key* is due.

    Spotify removed every batch read in February 2026, so work that used to be
    one request for fifty tracks is now fifty requests — against a quota that
    since July counts per *developer account* rather than per client id.  The
    spacing is what keeps a large deck from spending the whole account's quota
    in one burst.
    """
    interval = _throttle_interval.get(key, 0.0)
    if interval <= 0:
        return

    lock = _throttle_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _throttle_locks[key] = lock

    async with lock:
        due = _throttle_last.get(key, 0.0) + interval
        now = time.monotonic()
        if now < due:
            await asyncio.sleep(due - now)
        _throttle_last[key] = time.monotonic()


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
    throttle_key: Optional[str] = None,
) -> Any:
    """Send a request with retry/backoff and normalised error mapping.

    Returns parsed JSON (or ``None`` for empty bodies) when *expect_json*,
    otherwise the raw :class:`httpx.Response`.

    *throttle_key* opts the call into the shared spacer (see :func:`throttle`),
    which connectors use for the request storms that batch removals created.
    """
    last_error: Optional[str] = None

    for attempt in range(1, MAX_RETRIES + 1):
        if throttle_key:
            await throttle(throttle_key)
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
            reason = error_reason(resp)
            if reason in QUOTA_REASONS:
                # Not a speed problem — the account's allowance is gone, and
                # since July 2026 Spotify counts it per developer account, so
                # every client id of ours is out at the same time.  Waiting a
                # few seconds cannot fix that; say so instead of retrying.
                logger.warning("%s quota exhausted (%s)", provider, reason)
                raise ProviderQuotaError(
                    f"{provider}: quota exhausted ({reason}) — the developer "
                    f"account's API allowance is used up, not just this request"
                )
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
            raise _tagged(_auth_error(provider, resp), resp.status_code)

        if resp.status_code >= 400:
            raise _tagged(
                ProviderError(f"{provider}: HTTP {resp.status_code} — {_snippet(resp)}"),
                resp.status_code,
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


def _tagged(exc: ProviderError, status: int) -> ProviderError:
    """Record the service's own status code on the error before it travels.

    Connectors need to tell "you may not read this" from "this is broken", and
    grepping the message for a number is the kind of check that survives right
    up until someone rewords the message.
    """
    exc.http_status = status
    return exc


def _retry_after(resp: httpx.Response) -> int:
    raw = resp.headers.get("Retry-After", "2")
    try:
        return max(1, int(float(raw)))
    except ValueError:
        return 2


def error_reason(resp: httpx.Response) -> str:
    """The machine-readable ``reason`` from a provider error body, if any.

    Spotify's July 2026 shape is
    ``{"error": {"status": 429, "message": "...", "reason": "QUOTA_EXCEEDED"}}``.
    Anything that is not that shape yields ``""`` rather than an exception —
    an error path is the worst place to add a new way to fail.
    """
    try:
        body = json.loads(resp.text or "")
    except (ValueError, TypeError):
        return ""
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    if not isinstance(error, dict):
        return ""
    reason = error.get("reason")
    return reason if isinstance(reason, str) else ""


def _auth_error(provider: str, resp: httpx.Response) -> ProviderError:
    body = _snippet(resp)
    if resp.status_code == 401:
        return ProviderAuthError(f"{provider}: credentials rejected — {body}")
    # 403 on a music API is usually "wrong tier" or "missing scope", and the
    # difference matters a lot to the user, so keep the provider's own words.
    reason = error_reason(resp)
    lowered = body.lower()
    if reason in QUOTA_REASONS or "quota" in lowered or "rate" in lowered:
        return ProviderQuotaError(f"{provider}: quota exceeded — {body}")
    # Since Spotify removed ``product`` from GET /me, a refusal like this is
    # the *first* moment we can know the listener has no Premium — so it has to
    # carry that meaning rather than read as a generic failure.
    if reason == "PREMIUM_REQUIRED" or "premium" in lowered:
        return ProviderPaidTierRequired(
            f"{provider}: this account has no Premium subscription — {body}"
        )
    return ProviderError(f"{provider}: refused (403) — {body}")


def _snippet(resp: httpx.Response, limit: int = 300) -> str:
    text = (resp.text or "").strip().replace("\n", " ")
    return text[:limit] or "(empty body)"
