#!/usr/bin/env python3
"""Validate a Mika V4 execution checkpoint and detect revision drift."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


PHASES = {
    "GROUND",
    "INTAKE",
    "DIRECT",
    "HARNESS",
    "PLAN",
    "BUILD",
    "INTEGRATE",
    "VERIFY",
    "REVIEW",
    "REPAIR",
    "SHIP",
    "POST_DEPLOY",
    "CLOSE",
}
STATUSES = {"COMPLETE", "PARTIAL", "BLOCKED"}
LIST_FIELDS = {
    "owners",
    "completed",
    "in_progress",
    "blocked",
    "capability_blockers",
    "recovery_state",
    "next_actions",
}


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def timezone_aware_iso8601(value: Any) -> bool:
    if not nonempty_string(value):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def validate(data: Any, current_revision: str | None) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["checkpoint must be a JSON object"], {}
    if data.get("schema_version") != "1.0":
        errors.append("schema_version must be '1.0'")
    if not nonempty_string(data.get("project")):
        errors.append("project must be a non-empty string")

    subject = data.get("subject")
    if not isinstance(subject, dict):
        errors.append("subject must be an object")
        subject = {}
    for field in ("revision", "artifact_ref"):
        if not nonempty_string(subject.get(field)):
            errors.append(f"subject.{field} must be a non-empty string")

    if data.get("phase") not in PHASES:
        errors.append(f"phase must be one of {sorted(PHASES)}")
    if data.get("status") not in STATUSES:
        errors.append(f"status must be one of {sorted(STATUSES)}")
    if not nonempty_string(data.get("active_plan_ref")):
        errors.append("active_plan_ref must be a non-empty string")
    for field in sorted(LIST_FIELDS):
        value = data.get(field)
        if not isinstance(value, list) or not all(nonempty_string(item) for item in value):
            errors.append(f"{field} must be an array of non-empty strings")
    if not timezone_aware_iso8601(data.get("updated_at")):
        errors.append("updated_at must be timezone-aware ISO-8601")

    stale = False
    if current_revision is not None:
        if not nonempty_string(current_revision):
            errors.append("current revision must be a non-empty string")
        elif subject.get("revision") != current_revision:
            stale = True
            errors.append("checkpoint subject differs from current revision; re-ground")

    summary = {
        "phase": data.get("phase"),
        "status": data.get("status"),
        "checkpoint_revision": subject.get("revision"),
        "current_revision": current_revision,
        "stale": stale,
    }
    return errors, summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("--current-revision")
    args = parser.parse_args(argv[1:])
    try:
        if args.checkpoint == "-":
            data = json.load(sys.stdin)
        else:
            with Path(args.checkpoint).open("r", encoding="utf-8") as handle:
                data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, indent=2))
        return 1
    errors, summary = validate(data, args.current_revision)
    print(json.dumps({"valid": not errors, "errors": errors, "summary": summary}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
