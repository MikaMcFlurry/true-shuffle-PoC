"""Declared-but-not-implemented connectors.

These exist so the extension point is visible and honest.  Adding a service to
true-shuffle means writing one :class:`~providers.base.MusicProvider` subclass
— nothing in ``core/`` or ``app/`` changes.  Until that class exists, the
service is listed here with the specific reason it is not live, and the UI
shows it as unavailable rather than implying support.

The handoff is explicit that a February-2026 policy read is not evidence about
today, so each entry records what still needs to be checked instead of stating
a conclusion.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class PlannedProvider:
    id: str
    display_name: str
    brand_color: str
    #: What a connector would most likely be able to do.
    likely_mode: str
    #: What has to be verified before writing the connector.
    open_questions: List[str]


PLANNED: List[PlannedProvider] = [
    PlannedProvider(
        id="deezer",
        display_name="Deezer",
        brand_color="#A238FF",
        likely_mode="Copy Mode (playlist read/write)",
        open_questions=[
            "Confirm current OAuth scopes for playlist write.",
            "Confirm whether any playback control is available to third parties.",
        ],
    ),
    PlannedProvider(
        id="tidal",
        display_name="TIDAL",
        brand_color="#00FFFF",
        likely_mode="Copy Mode, possibly Live Mode via the official SDK",
        open_questions=[
            "Re-check the current developer programme terms.",
            "Confirm whether third-party playback control is permitted.",
        ],
    ),
    PlannedProvider(
        id="amazon",
        display_name="Amazon Music",
        brand_color="#25D1DA",
        likely_mode="Unknown — partner programme",
        open_questions=[
            "Determine whether a public developer programme exists at all.",
        ],
    ),
    PlannedProvider(
        id="soundcloud",
        display_name="SoundCloud",
        brand_color="#FF5500",
        likely_mode="Copy Mode, plus an embeddable web player",
        open_questions=[
            "Confirm API application approval is still open to new apps.",
        ],
    ),
]


def as_dicts() -> List[dict]:
    return [
        {
            "id": p.id,
            "display_name": p.display_name,
            "brand_color": p.brand_color,
            "likely_mode": p.likely_mode,
            "open_questions": list(p.open_questions),
            "status": "planned",
        }
        for p in PLANNED
    ]
