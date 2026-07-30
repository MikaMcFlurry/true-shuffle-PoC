"""Export/import: portability without leaking credentials."""

from __future__ import annotations

import json

import pytest

from core.exporter import export_run, import_run, resume_status
from core.models import EXPORT_VERSION, RunMode, RunStatus


def sample(**overrides) -> str:
    payload = {
        "provider": "spotify",
        "playlist_id": "pl1",
        "playlist_name": "Everything",
        "mode": "controller",
        "order": ["a", "b", "c"],
        "cursor": 1,
        "status": "active",
    }
    payload.update(overrides)
    return export_run(**payload)


def test_export_round_trips():
    payload = import_run(sample())
    assert payload.provider == "spotify"
    assert payload.order == ["a", "b", "c"]
    assert payload.cursor == 1
    assert payload.version == EXPORT_VERSION


def test_export_records_a_timestamp():
    assert json.loads(sample())["exported_at"]


def test_export_never_contains_tokens():
    raw = sample().lower()
    for secret in ("access_token", "refresh_token", "music_user_token", "client_secret"):
        assert secret not in raw


@pytest.mark.parametrize(
    "key",
    ["access_token", "refresh_token", "token_data", "music_user_token", "client_secret"],
)
def test_credentials_in_an_uploaded_file_are_stripped(key):
    data = json.loads(sample())
    data[key] = "leaked-value"
    payload = import_run(json.dumps(data))
    assert "leaked-value" not in payload.model_dump_json()


# -- v1 compatibility --------------------------------------------------------

def test_a_v1_spotify_export_still_imports():
    """The old format stored full URIs under ``shuffled_order``."""
    legacy = {
        "playlist_id": "pl1",
        "mode": "utility",
        "shuffled_order": [
            "spotify:track:aaa", "spotify:track:bbb", "spotify:track:ccc",
        ],
        "cursor": 2,
        "status": "active",
        "exported_at": "2026-02-22T01:14:00+00:00",
    }
    payload = import_run(json.dumps(legacy))
    assert payload.provider == "spotify"
    assert payload.order == ["aaa", "bbb", "ccc"]
    assert payload.version == EXPORT_VERSION
    assert payload.mode is RunMode.UTILITY


# -- validation --------------------------------------------------------------

def test_invalid_json_is_rejected():
    with pytest.raises(ValueError):
        import_run("{not json")


def test_a_json_array_is_rejected():
    with pytest.raises(ValueError):
        import_run("[1, 2, 3]")


def test_an_empty_deck_is_rejected():
    with pytest.raises(ValueError, match="no tracks"):
        import_run(json.dumps({"version": 2, "provider": "spotify",
                               "playlist_id": "p", "order": [], "cursor": 0,
                               "status": "active", "mode": "utility"}))


def test_an_out_of_range_cursor_is_rejected():
    data = json.loads(sample())
    data["cursor"] = 99
    with pytest.raises(ValueError, match="cursor"):
        import_run(json.dumps(data))


def test_a_cursor_at_the_very_end_is_allowed():
    """Exporting a just-finished deck must not be treated as corruption."""
    payload = import_run(sample(cursor=3))
    assert payload.cursor == 3


# -- resume semantics --------------------------------------------------------

def test_an_unfinished_import_resumes_as_paused():
    assert resume_status(import_run(sample(cursor=1))) is RunStatus.PAUSED


def test_a_finished_import_stays_finished():
    assert resume_status(import_run(sample(cursor=3))) is RunStatus.COMPLETED
