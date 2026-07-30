"""Background jobs with live progress.

Reading a 10 000-track playlist is 200 sequential API calls; writing a
shuffled copy is 100 more.  Doing that inside a POST handler is why the old
Utility Mode looked frozen on exactly the playlists this product exists for.

Jobs run as asyncio tasks in the same process — right for a PoC, and the
persistence boundary (the ``jobs`` table) is deliberately the same one a real
queue would use, so swapping in a worker later does not change the API.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app import db

logger = logging.getLogger(__name__)

#: run_id/job_id → asyncio queues fed by progress updates, drained by SSE.
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_tasks: Dict[str, asyncio.Task] = {}


def new_job_id() -> str:
    return secrets.token_urlsafe(9)


async def publish(job_id: str, payload: Dict[str, Any]) -> None:
    """Push a progress frame to every listener of *job_id*."""
    for queue in list(_subscribers.get(job_id, [])):
        # A listener that fell behind loses frames rather than blocking the job.
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(payload)


def subscribe(job_id: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _subscribers.setdefault(job_id, []).append(queue)
    return queue


def unsubscribe(job_id: str, queue: asyncio.Queue) -> None:
    listeners = _subscribers.get(job_id)
    if not listeners:
        return
    if queue in listeners:
        listeners.remove(queue)
    if not listeners:
        _subscribers.pop(job_id, None)


async def report(
    job_id: str, processed: int, total: int, phase: str, message: str = ""
) -> None:
    """Progress callback handed to long-running work."""
    await db.update_job(
        job_id, status="running", phase=phase, processed=processed,
        total=total, message=message,
    )
    await publish(
        job_id,
        {
            "status": "running", "phase": phase, "processed": processed,
            "total": total, "message": message,
        },
    )


async def start(
    job_id: str,
    user_id: int,
    kind: str,
    work: Callable[[], Awaitable[Dict[str, Any]]],
) -> None:
    """Register and launch a job.  Never raises out of the worker."""
    await db.create_job(job_id, user_id, kind)

    async def _run() -> None:
        try:
            result = await work()
            await db.update_job(job_id, status="done", message="", result=result)
            await publish(job_id, {"status": "done", "result": result})
        except asyncio.CancelledError:  # pragma: no cover - shutdown
            await db.update_job(job_id, status="cancelled")
            await publish(job_id, {"status": "cancelled"})
            raise
        except Exception as exc:
            logger.exception("job %s (%s) failed", job_id, kind)
            await db.update_job(job_id, status="error", message=str(exc))
            await publish(job_id, {"status": "error", "message": str(exc)})
        finally:
            _tasks.pop(job_id, None)

    _tasks[job_id] = asyncio.create_task(_run(), name=f"ts-job-{job_id}")


async def cancel_all() -> None:
    for task in list(_tasks.values()):
        task.cancel()
    for task in list(_tasks.values()):
        # Shutdown must not be blocked by whatever a job happened to be doing.
        with contextlib.suppress(BaseException):
            await task
    _tasks.clear()


async def snapshot(job_id: str, user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Current job state, for polling clients and the initial SSE frame."""
    job = await db.get_job(job_id, user_id)
    if job is None:
        return None
    return {
        "id": job["id"],
        "kind": job["kind"],
        "status": job["status"],
        "phase": job["phase"],
        "processed": job["processed"],
        "total": job["total"],
        "message": job["message"],
        "result": job["result"],
    }
