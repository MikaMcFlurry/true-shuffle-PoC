#!/usr/bin/env python3
"""Validate a Mika Evidence Ledger 1.2 without external packages."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


MODES = {"AUTONOMOUS_BUILD", "GOVERNED_EXECUTION", "EXPERIMENT"}
DELIVERY_STATES = {"PRODUCTION_LIVE", "RELEASE_CANDIDATE", "VERIFIED_PROTOTYPE"}
CLAIMS = DELIVERY_STATES | {"PARTIAL", "BLOCKED"}
STATUSES = {"PASS", "FAIL", "NOT_RUN", "NOT_APPLICABLE"}
INDEPENDENCE_LEVELS = {"FRESH", "PARTIALLY_INDEPENDENT", "COMPROMISED", "NOT_REQUIRED", "NOT_RUN"}
REVIEW_VERDICTS = {"READY", "READY_WITH_NON_BLOCKING_FINDINGS", "NOT_READY", "BLOCKED", "NOT_REQUIRED", "NOT_RUN"}
SEVERITIES = {"P0", "P1", "P2", "P3"}
CHANGE_PROFILES = {
    "USER_FACING",
    "PERSISTENT_STATE_CHANGE",
    "AUTHORIZATION_OR_SENSITIVE_DATA",
    "PAYMENTS_OR_FINANCIAL_STATE",
    "AI_TOOL_SIDE_EFFECTS",
    "REALTIME_OR_MULTIPLAYER_AUTHORITY",
    "PERFORMANCE_CRITICAL",
    "NONE",
}
BLOCKER_TYPES = {"AUTHORITY", "CREDENTIAL", "PROVIDER_REVIEW", "CERTIFICATE", "CONTRACT", "THIRD_PARTY_APPROVAL", "TOOL_UNAVAILABLE"}
TOP_LEVEL = {
    "schema_version", "generated_at", "project", "subject", "mode", "delivery_target", "claim",
    "material_release", "change_profiles", "independent_review_level",
    "independent_review_verdict", "required_categories", "external_blockers",
    "requirements_snapshot", "protected_requirements", "open_findings", "gates",
}
ENVIRONMENT_CLASSES = {"LOCAL", "CI", "PREVIEW", "STAGING", "PRODUCTION", "EXPERIMENT", "OTHER"}
PROFILE_CATEGORIES = {
    "USER_FACING": {"ui_runtime", "accessibility"},
    "PERSISTENT_STATE_CHANGE": {"migration", "data_invariants", "recovery"},
    "AUTHORIZATION_OR_SENSITIVE_DATA": {"security_privacy"},
    "PAYMENTS_OR_FINANCIAL_STATE": {"security_privacy"},
    "AI_TOOL_SIDE_EFFECTS": {"security_privacy"},
    "REALTIME_OR_MULTIPLAYER_AUTHORITY": {"security_privacy", "performance_reliability"},
    "PERFORMANCE_CRITICAL": {"performance_reliability"},
    "NONE": set(),
}
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"),
]


def load_json(source: str) -> Any:
    if source == "-":
        return json.load(sys.stdin)
    with Path(source).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def parse_timezone_iso(value: Any) -> datetime | None:
    if not nonempty(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def timezone_iso(value: Any) -> bool:
    return parse_timezone_iso(value) is not None


def as_object(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return {}
    return value


def as_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return []
    return value


def reject_extra(value: dict[str, Any], allowed: set[str], label: str, errors: list[str]) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        errors.append(f"{label} has unsupported fields: {', '.join(extra)}")


def unique_strings(values: Any, label: str, errors: list[str], *, nonempty_required: bool = False) -> list[str]:
    items = as_list(values, label, errors)
    if nonempty_required and not items:
        errors.append(f"{label} must not be empty")
    if not all(nonempty(item) for item in items):
        errors.append(f"{label} must contain only non-empty strings")
        return []
    if len(items) != len(set(items)):
        errors.append(f"{label} must not contain duplicates")
    return items


def walk_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from walk_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_strings(child)


def validate(data: Any) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    root = as_object(data, "ledger", errors)
    if not root:
        return errors, {}
    reject_extra(root, TOP_LEVEL, "ledger", errors)
    missing = sorted(TOP_LEVEL - set(root))
    if missing:
        errors.append("missing top-level fields: " + ", ".join(missing))

    if root.get("schema_version") != "1.2":
        errors.append("schema_version must be '1.2'")
    ledger_generated_at = parse_timezone_iso(root.get("generated_at"))
    if ledger_generated_at is None:
        errors.append("generated_at must be timezone-aware ISO-8601")
    if not nonempty(root.get("project")):
        errors.append("project must be a non-empty string")

    subject = as_object(root.get("subject"), "subject", errors)
    reject_extra(subject, {"revision", "artifact_ref", "environment", "environment_class"}, "subject", errors)
    for field in ("revision", "artifact_ref", "environment"):
        if not nonempty(subject.get(field)):
            errors.append(f"subject.{field} must be a non-empty string")
    if subject.get("environment_class") not in ENVIRONMENT_CLASSES:
        errors.append(f"subject.environment_class must be one of {sorted(ENVIRONMENT_CLASSES)}")

    mode = root.get("mode")
    target = root.get("delivery_target")
    claim = root.get("claim")
    material = root.get("material_release")
    level = root.get("independent_review_level")
    verdict = root.get("independent_review_verdict")
    if mode not in MODES:
        errors.append(f"mode must be one of {sorted(MODES)}")
    if target not in DELIVERY_STATES:
        errors.append(f"delivery_target must be one of {sorted(DELIVERY_STATES)}")
    if claim not in CLAIMS:
        errors.append(f"claim must be one of {sorted(CLAIMS)}")
    if not isinstance(material, bool):
        errors.append("material_release must be a boolean")
    if level not in INDEPENDENCE_LEVELS:
        errors.append(f"independent_review_level must be one of {sorted(INDEPENDENCE_LEVELS)}")
    if verdict not in REVIEW_VERDICTS:
        errors.append(f"independent_review_verdict must be one of {sorted(REVIEW_VERDICTS)}")
    if level in {"NOT_RUN", "NOT_REQUIRED"} and verdict != level:
        errors.append(f"{level} independence requires matching review verdict")
    if level in {"FRESH", "PARTIALLY_INDEPENDENT", "COMPROMISED"} and verdict in {"NOT_RUN", "NOT_REQUIRED"}:
        errors.append("an executed independence level requires an executed review verdict")

    profiles = unique_strings(root.get("change_profiles"), "change_profiles", errors, nonempty_required=True)
    invalid_profiles = sorted(set(profiles) - CHANGE_PROFILES)
    if invalid_profiles:
        errors.append("invalid change_profiles: " + ", ".join(invalid_profiles))
    if "NONE" in profiles and len(profiles) != 1:
        errors.append("change_profiles NONE must be used alone")

    required_categories = unique_strings(root.get("required_categories"), "required_categories", errors)

    blocker_ids: set[str] = set()
    blockers = as_list(root.get("external_blockers"), "external_blockers", errors)
    for index, value in enumerate(blockers):
        prefix = f"external_blockers[{index}]"
        item = as_object(value, prefix, errors)
        reject_extra(item, {"id", "type", "description", "evidence_ref"}, prefix, errors)
        blocker_id = item.get("id")
        if not nonempty(blocker_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif blocker_id in blocker_ids:
            errors.append(f"duplicate external blocker id: {blocker_id}")
        else:
            blocker_ids.add(blocker_id)
        if item.get("type") not in BLOCKER_TYPES:
            errors.append(f"{prefix}.type must be one of {sorted(BLOCKER_TYPES)}")
        for field in ("description", "evidence_ref"):
            if not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")

    finding_ids: set[str] = set()
    has_p0_p1 = False
    has_blocking = False
    findings = as_list(root.get("open_findings"), "open_findings", errors)
    for index, value in enumerate(findings):
        prefix = f"open_findings[{index}]"
        item = as_object(value, prefix, errors)
        reject_extra(item, {"id", "title", "severity", "blocking"}, prefix, errors)
        finding_id = item.get("id")
        if not nonempty(finding_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif finding_id in finding_ids:
            errors.append(f"duplicate open finding id: {finding_id}")
        else:
            finding_ids.add(finding_id)
        if not nonempty(item.get("title")):
            errors.append(f"{prefix}.title must be a non-empty string")
        severity = item.get("severity")
        blocking = item.get("blocking")
        if severity not in SEVERITIES:
            errors.append(f"{prefix}.severity must be one of {sorted(SEVERITIES)}")
        if not isinstance(blocking, bool):
            errors.append(f"{prefix}.blocking must be a boolean")
        if severity in {"P0", "P1"}:
            has_p0_p1 = True
            if blocking is not True:
                errors.append(f"{prefix}: P0/P1 findings must be blocking")
        if blocking is True:
            has_blocking = True

    if verdict == "READY" and findings:
        errors.append("READY review verdict cannot retain open findings")
    if verdict == "READY_WITH_NON_BLOCKING_FINDINGS":
        if not findings:
            errors.append("READY_WITH_NON_BLOCKING_FINDINGS requires open findings")
        if has_p0_p1 or has_blocking:
            errors.append("READY_WITH_NON_BLOCKING_FINDINGS cannot retain P0/P1 or blocking findings")
    if has_p0_p1 and verdict != "BLOCKED":
        errors.append("open P0/P1 findings require BLOCKED review verdict")

    gate_ids: set[str] = set()
    evidence_ids: set[str] = set()
    required_gate_ids: set[str] = set()
    required_gate_categories: set[str] = set()
    required_statuses: list[str] = []
    status_counts: Counter[str] = Counter()
    gates = as_list(root.get("gates"), "gates", errors)
    for index, value in enumerate(gates):
        prefix = f"gates[{index}]"
        gate = as_object(value, prefix, errors)
        reject_extra(gate, {"id", "category", "required", "status", "evidence", "rationale"}, prefix, errors)
        gate_id = gate.get("id")
        category = gate.get("category")
        required = gate.get("required")
        status = gate.get("status")
        rationale = gate.get("rationale")
        if not nonempty(gate_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif gate_id in gate_ids:
            errors.append(f"duplicate gate id: {gate_id}")
        else:
            gate_ids.add(gate_id)
        if not nonempty(category):
            errors.append(f"{prefix}.category must be a non-empty string")
        if not isinstance(required, bool):
            errors.append(f"{prefix}.required must be a boolean")
        if status not in STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(STATUSES)}")
        else:
            status_counts[status] += 1
        if not isinstance(rationale, str):
            errors.append(f"{prefix}.rationale must be a string")

        evidence = as_list(gate.get("evidence"), f"{prefix}.evidence", errors)
        for evidence_index, evidence_value in enumerate(evidence):
            evidence_prefix = f"{prefix}.evidence[{evidence_index}]"
            item = as_object(evidence_value, evidence_prefix, errors)
            reject_extra(item, {"id", "kind", "ref", "result", "subject_revision", "observed_at"}, evidence_prefix, errors)
            evidence_id = item.get("id")
            if not nonempty(evidence_id):
                errors.append(f"{evidence_prefix}.id must be a non-empty string")
            elif evidence_id in evidence_ids:
                errors.append(f"duplicate evidence id: {evidence_id}")
            else:
                evidence_ids.add(evidence_id)
            for field in ("kind", "ref", "result", "subject_revision"):
                if not nonempty(item.get(field)):
                    errors.append(f"{evidence_prefix}.{field} must be a non-empty string")
            if nonempty(item.get("subject_revision")) and item.get("subject_revision") != subject.get("revision"):
                errors.append(f"{evidence_prefix}.subject_revision must match subject.revision")
            observed_at = parse_timezone_iso(item.get("observed_at"))
            if observed_at is None:
                errors.append(f"{evidence_prefix}.observed_at must be timezone-aware ISO-8601")
            elif ledger_generated_at is not None and observed_at > ledger_generated_at:
                errors.append(f"{evidence_prefix}.observed_at cannot be later than ledger.generated_at")

        if status == "PASS" and not evidence:
            errors.append(f"{prefix}: PASS requires evidence")
        if status == "NOT_APPLICABLE" and not nonempty(rationale):
            errors.append(f"{prefix}: NOT_APPLICABLE requires rationale")
        if required is True:
            if nonempty(gate_id):
                required_gate_ids.add(gate_id)
            if nonempty(category):
                required_gate_categories.add(category)
            if status in STATUSES:
                required_statuses.append(status)
            if status == "NOT_APPLICABLE":
                errors.append(f"{prefix}: a required gate cannot be NOT_APPLICABLE")

    listed_categories = set(required_categories)
    if listed_categories != required_gate_categories:
        missing = sorted(required_gate_categories - listed_categories)
        extra = sorted(listed_categories - required_gate_categories)
        if missing:
            errors.append("required gate categories missing from required_categories: " + ", ".join(missing))
        if extra:
            errors.append("required_categories without a required gate: " + ", ".join(extra))

    profile_required: set[str] = set()
    for profile in profiles:
        profile_required |= PROFILE_CATEGORIES.get(profile, set())
    missing_profile_categories = sorted(profile_required - required_gate_categories)
    if missing_profile_categories:
        errors.append("change profiles require categories: " + ", ".join(missing_profile_categories))

    snapshot = as_object(root.get("requirements_snapshot"), "requirements_snapshot", errors)
    reject_extra(snapshot, {"source_ref", "source_revision", "non_negotiable_ids"}, "requirements_snapshot", errors)
    for field in ("source_ref", "source_revision"):
        if not nonempty(snapshot.get(field)):
            errors.append(f"requirements_snapshot.{field} must be a non-empty string")
    snapshot_ids = unique_strings(snapshot.get("non_negotiable_ids"), "requirements_snapshot.non_negotiable_ids", errors)

    protected_ids: set[str] = set()
    protected = as_list(root.get("protected_requirements"), "protected_requirements", errors)
    for index, value in enumerate(protected):
        prefix = f"protected_requirements[{index}]"
        item = as_object(value, prefix, errors)
        reject_extra(item, {"id", "statement", "gate_ids"}, prefix, errors)
        requirement_id = item.get("id")
        if not nonempty(requirement_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif requirement_id in protected_ids:
            errors.append(f"duplicate protected requirement id: {requirement_id}")
        else:
            protected_ids.add(requirement_id)
        if not nonempty(item.get("statement")):
            errors.append(f"{prefix}.statement must be a non-empty string")
        mapped_gates = unique_strings(item.get("gate_ids"), f"{prefix}.gate_ids", errors, nonempty_required=True)
        unresolved = sorted(set(mapped_gates) - required_gate_ids)
        if unresolved:
            errors.append(f"{prefix}.gate_ids do not resolve to required gates: {', '.join(unresolved)}")

    if set(snapshot_ids) != protected_ids:
        missing = sorted(set(snapshot_ids) - protected_ids)
        extra = sorted(protected_ids - set(snapshot_ids))
        if missing:
            errors.append("snapshot non-negotiables missing protected mappings: " + ", ".join(missing))
        if extra:
            errors.append("protected requirements absent from snapshot: " + ", ".join(extra))

    positive = claim in DELIVERY_STATES
    if positive:
        minimum = {"build", "critical_journey"}
        if material is True:
            minimum.add("independent_review")
        if claim == "PRODUCTION_LIVE":
            minimum |= {"deployment", "post_deploy", "operations"}
        missing_minimum = sorted(minimum - required_gate_categories)
        if missing_minimum:
            errors.append("positive claim requires categories: " + ", ".join(missing_minimum))
        if any(status != "PASS" for status in required_statuses):
            errors.append("positive claim requires every required gate to PASS")
        if has_p0_p1 or has_blocking:
            errors.append("positive claim cannot retain P0/P1 or blocking findings")
        if verdict in {"NOT_READY", "BLOCKED", "NOT_RUN"}:
            errors.append("positive claim conflicts with independent review verdict")
        if material is True:
            if level != "FRESH":
                errors.append("material positive claim requires FRESH independent review")
            if verdict not in {"READY", "READY_WITH_NON_BLOCKING_FINDINGS"}:
                errors.append("material positive claim requires a ready independent review verdict")

        if claim in {"PRODUCTION_LIVE", "RELEASE_CANDIDATE"} and material is not True:
            errors.append(f"{claim} must be marked as a material release")
        if claim == "PRODUCTION_LIVE":
            if target != "PRODUCTION_LIVE":
                errors.append("PRODUCTION_LIVE claim requires matching delivery_target")
            if subject.get("environment_class") != "PRODUCTION":
                errors.append("PRODUCTION_LIVE claim requires subject.environment_class PRODUCTION")
            if blockers:
                errors.append("PRODUCTION_LIVE cannot retain external blockers")
        if claim == "RELEASE_CANDIDATE":
            if target not in {"PRODUCTION_LIVE", "RELEASE_CANDIDATE"}:
                errors.append("RELEASE_CANDIDATE requires a production or release-candidate target")
            if not blockers:
                errors.append("RELEASE_CANDIDATE requires a structured external blocker")
        if claim == "VERIFIED_PROTOTYPE":
            if mode != "EXPERIMENT":
                errors.append("VERIFIED_PROTOTYPE requires EXPERIMENT mode")
            if target != "VERIFIED_PROTOTYPE":
                errors.append("VERIFIED_PROTOTYPE claim requires matching delivery_target")

    serialized = json.dumps(root, ensure_ascii=False)
    for pattern in SECRET_PATTERNS:
        if pattern.search(serialized):
            errors.append("ledger appears to contain an unredacted secret or private key")
            break

    summary = {
        "claim": claim,
        "delivery_target": target,
        "subject_revision": subject.get("revision"),
        "change_profiles": profiles,
        "independent_review_verdict": verdict,
        "gate_count": len(gates),
        "required_gate_count": len(required_statuses),
        "status_counts": dict(sorted(status_counts.items())),
        "protected_requirement_count": len(protected_ids),
        "open_finding_count": len(findings),
        "external_blocker_count": len(blockers),
    }
    return errors, summary


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_evidence.py <ledger.json|->", file=sys.stderr)
        return 2
    try:
        data = load_json(argv[1])
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, indent=2))
        return 1
    errors, summary = validate(data)
    print(json.dumps({"valid": not errors, "errors": errors, "summary": summary}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
