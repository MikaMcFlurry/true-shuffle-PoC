#!/usr/bin/env python3
"""Validate a Mika Repository Intelligence Packet V2 without dependencies."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "mika.repository-intelligence.v2"
TOP_LEVEL = {
    "schema_version", "packet_status", "generated_at", "analysis_modes", "repositories",
    "primary_baseline", "authority_map", "product", "features", "architecture",
    "quality", "gaps", "owner_alignment", "handoff_readiness", "recommendation", "evidence",
}
PACKET_STATUSES = {"ANALYZED", "ALIGNED", "BLOCKED"}
MODES = {"AUTO", "LIVE_BASELINE", "LOST_CONTEXT", "SPEC_IMPLEMENTATION_GAP", "PORTFOLIO_RESOLUTION"}
REPO_ROLES = {"CURRENT_PRIMARY", "CURRENT_COMPONENT", "PRODUCTION_SOURCE", "SUCCESSOR", "LEGACY", "EXPERIMENT", "HANDOFF_ONLY", "ARCHIVE", "DUPLICATE", "UNRESOLVED"}
VISIBILITIES = {"public", "private", "internal", "unknown"}
FEATURE_STATES = {"VERIFIED_LIVE", "VERIFIED_RUNTIME_NONPROD", "IMPLEMENTED_TESTED", "IMPLEMENTED_UNVERIFIED", "PARTIAL", "PLANNED_ONLY", "DISABLED_OR_HIDDEN", "DEPRECATED_OR_DEAD", "CONTRADICTED", "UNKNOWN"}
DISPOSITIONS = {"KEEP", "IMPROVE", "REDESIGN", "REMOVE", "ADD", "PIVOT", "DEFER", "STUDIO_DECIDES", "UNDECIDED"}
EVIDENCE_LEVELS = {"OBSERVED_RUNTIME", "PROVIDER_CONFIRMED", "CODE_CONFIRMED", "TEST_CONFIRMED", "CI_CONFIRMED", "DOC_CORROBORATED", "CLAIM_ONLY", "INFERRED", "UNKNOWN"}
EVIDENCE_TYPES = {"REPOSITORY", "FILE", "COMMIT", "BRANCH", "PULL_REQUEST", "ISSUE", "CI", "TEST_RUN", "RUNTIME", "DEPLOYMENT", "PROVIDER", "OWNER_STATEMENT", "EXTERNAL_SOURCE"}
SOURCE_STATUSES = {"AUTHORITATIVE", "CURRENT_SUPPORTING", "STALE", "CONTRADICTED", "HISTORICAL", "UNRESOLVED"}
QUALITY_STATUSES = {"PASS", "FAIL", "NOT_RUN", "BLOCKED", "CLAIM_ONLY", "UNKNOWN"}
QUESTION_STATUSES = {"RESOLVED", "DELEGATED", "NOT_BLOCKING", "OPEN"}
HANDOFF_STATUSES = {"READY", "NOT_READY", "BLOCKED"}
CONFLICT_AXES = {"CURRENT_REALITY", "TARGET_INTENT", "GOVERNANCE"}
CONFLICT_STATUSES = {"RESOLVED", "UNRESOLVED", "OWNER_DECISION", "GOVERNANCE_DECISION"}
ENVIRONMENT_TYPES = {"LOCAL", "PREVIEW", "STAGING", "PRODUCTION", "STORE", "UNKNOWN"}
ENVIRONMENT_STATUSES = {"VERIFIED", "UNVERIFIED", "BLOCKED", "UNKNOWN"}
DELIVERY_STATES = {"PLANNING", "PROTOTYPE", "ALPHA", "BETA", "RELEASE_CANDIDATE", "LIVE", "MIXED", "UNKNOWN"}
SATISFACTION_STATES = {"SATISFIED", "MIXED", "DISSATISFIED", "UNKNOWN"}
QUALITY_CATEGORIES = {"build", "tests", "runtime", "security", "accessibility", "performance", "operations", "migration", "recovery"}
GAP_CLASSES = {"PLANNED_NOT_IMPLEMENTED", "IMPLEMENTED_NOT_DOCUMENTED", "DOCUMENTED_BUT_STALE", "TESTED_BUT_NOT_DEPLOYED", "DEPLOYED_BUT_NOT_REPRODUCIBLE", "LIVE_BUT_NOT_OBSERVABLE", "FEATURE_PRESENT_BUT_OWNER_REJECTED", "DUPLICATE_OR_SUPERSEDED", "AUTHORITY_CONFLICT", "UNVERIFIED_CLAIM"}
SEVERITIES = {"P0", "P1", "P2", "P3", "INFO"}
ENGAGEMENT_TYPES = {"TAKEOVER", "RESCUE", "MODERNIZE", "FEATURE", "MIGRATION", "RELEASE", "GOVERNED_EXECUTION", "EXPERIMENT"}
HANDOFF_PROFILES = {"LEAN", "STANDARD", "LIVE_SYSTEM", "GOVERNED", "MULTI_REPO"}
SENSITIVITY_LEVELS = {"PUBLIC", "INTERNAL", "SENSITIVE_REDACTED"}
SHA_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"),
]


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON at {exc.lineno}:{exc.colno}: {exc.msg}") from exc


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def full_sha(value: Any) -> bool:
    return isinstance(value, str) and SHA_RE.fullmatch(value) is not None


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


def string_list(value: Any, label: str, errors: list[str], *, nonempty_list: bool = False) -> list[str]:
    items = as_list(value, label, errors)
    if nonempty_list and not items:
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


def unique_object_ids(items: list[Any], label: str, errors: list[str]) -> tuple[set[str], list[dict[str, Any]]]:
    ids: set[str] = set()
    objects: list[dict[str, Any]] = []
    for index, value in enumerate(items):
        item = as_object(value, f"{label}[{index}]", errors)
        objects.append(item)
        item_id = item.get("id")
        if not nonempty(item_id):
            errors.append(f"{label}[{index}].id must be a non-empty string")
        elif item_id in ids:
            errors.append(f"duplicate {label} id: {item_id}")
        else:
            ids.add(item_id)
    return ids, objects


def validate_refs(refs: Any, label: str, evidence_ids: set[str], errors: list[str], *, require: bool = False) -> list[str]:
    values = string_list(refs, label, errors, nonempty_list=require)
    missing = sorted(set(values) - evidence_ids)
    if missing:
        errors.append(f"{label} references unknown evidence: {', '.join(missing)}")
    return values


def validate(data: Any, current_primary_sha: str | None) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    root = as_object(data, "packet", errors)
    if not root:
        return errors, warnings, {}
    reject_extra(root, TOP_LEVEL, "packet", errors)
    missing = sorted(TOP_LEVEL - set(root))
    if missing:
        errors.append("missing top-level fields: " + ", ".join(missing))

    if root.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must equal {SCHEMA_VERSION}")
    packet_status = root.get("packet_status")
    if packet_status not in PACKET_STATUSES:
        errors.append(f"packet_status must be one of {sorted(PACKET_STATUSES)}")
    packet_generated_at = parse_timezone_iso(root.get("generated_at"))
    if packet_generated_at is None:
        errors.append("generated_at must be timezone-aware ISO-8601")
    modes = string_list(root.get("analysis_modes"), "analysis_modes", errors, nonempty_list=True)
    invalid_modes = sorted(set(modes) - MODES)
    if invalid_modes:
        errors.append("invalid analysis_modes: " + ", ".join(invalid_modes))

    repo_items = as_list(root.get("repositories"), "repositories", errors)
    if not repo_items:
        errors.append("repositories must contain at least one repository")
    repo_ids, repos = unique_object_ids(repo_items, "repositories", errors)
    repo_by_id: dict[str, dict[str, Any]] = {}
    for index, repo in enumerate(repos):
        prefix = f"repositories[{index}]"
        reject_extra(repo, {"id", "full_name", "url", "role", "visibility", "default_branch", "ref", "commit_sha", "notes"}, prefix, errors)
        if nonempty(repo.get("id")):
            repo_by_id[repo["id"]] = repo
        for field in ("full_name", "ref"):
            if not nonempty(repo.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if repo.get("role") not in REPO_ROLES:
            errors.append(f"{prefix}.role is invalid")
        if repo.get("visibility") not in VISIBILITIES:
            errors.append(f"{prefix}.visibility is invalid")
        for field in ("url", "default_branch"):
            if repo.get(field) is not None and not nonempty(repo.get(field)):
                errors.append(f"{prefix}.{field} must be null or a non-empty string")
        if not isinstance(repo.get("notes"), str):
            errors.append(f"{prefix}.notes must be a string")
        if not full_sha(repo.get("commit_sha")):
            errors.append(f"{prefix}.commit_sha must be a full 40- or 64-character hex commit")

    baseline = as_object(root.get("primary_baseline"), "primary_baseline", errors)
    reject_extra(baseline, {"repository_id", "ref", "commit_sha", "deployment_refs", "unavailable_systems"}, "primary_baseline", errors)
    baseline_repo = repo_by_id.get(baseline.get("repository_id"))
    if baseline_repo is None:
        errors.append("primary_baseline.repository_id must resolve to repositories[].id")
    else:
        if baseline_repo.get("role") != "CURRENT_PRIMARY":
            errors.append("primary_baseline must select a CURRENT_PRIMARY repository")
        if baseline.get("ref") != baseline_repo.get("ref"):
            errors.append("primary_baseline.ref must match the selected repository ref")
        if baseline.get("commit_sha") != baseline_repo.get("commit_sha"):
            errors.append("primary_baseline.commit_sha must match the selected repository commit")
    if not full_sha(baseline.get("commit_sha")):
        errors.append("primary_baseline.commit_sha must be a full commit")
    string_list(baseline.get("deployment_refs"), "primary_baseline.deployment_refs", errors)
    string_list(baseline.get("unavailable_systems"), "primary_baseline.unavailable_systems", errors)
    if current_primary_sha is not None:
        if not full_sha(current_primary_sha):
            errors.append("--current-primary-sha must be a full 40- or 64-character hex commit")
        elif str(baseline.get("commit_sha", "")).lower() != current_primary_sha.lower():
            errors.append("packet primary baseline differs from current primary SHA; refresh intelligence")
    current_primary_count = sum(repo.get("role") == "CURRENT_PRIMARY" for repo in repos)
    if current_primary_count != 1:
        errors.append("repositories must contain exactly one CURRENT_PRIMARY repository")

    evidence_items = as_list(root.get("evidence"), "evidence", errors)
    if not evidence_items:
        errors.append("evidence must contain at least one record")
    evidence_ids, evidence = unique_object_ids(evidence_items, "evidence", errors)
    evidence_level_by_id: dict[str, str] = {}
    for index, item in enumerate(evidence):
        prefix = f"evidence[{index}]"
        reject_extra(item, {"id", "type", "evidence_level", "claim", "repository_id", "ref", "commit_sha", "path_or_url", "environment", "artifact_ref", "observed_at", "source_status", "sensitivity"}, prefix, errors)
        if item.get("type") not in EVIDENCE_TYPES:
            errors.append(f"{prefix}.type is invalid")
        level = item.get("evidence_level")
        if level not in EVIDENCE_LEVELS:
            errors.append(f"{prefix}.evidence_level is invalid")
        elif nonempty(item.get("id")):
            evidence_level_by_id[item["id"]] = level
        if not nonempty(item.get("claim")):
            errors.append(f"{prefix}.claim must be a non-empty string")
        observed_at = parse_timezone_iso(item.get("observed_at"))
        if observed_at is None:
            errors.append(f"{prefix}.observed_at must be timezone-aware ISO-8601")
        elif packet_generated_at is not None and observed_at > packet_generated_at:
            errors.append(f"{prefix}.observed_at cannot be later than packet.generated_at")
        if item.get("source_status") not in SOURCE_STATUSES:
            errors.append(f"{prefix}.source_status is invalid")
        if item.get("sensitivity") not in SENSITIVITY_LEVELS:
            errors.append(f"{prefix}.sensitivity is invalid")
        for field in ("path_or_url", "environment", "artifact_ref"):
            if item.get(field) is not None and not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be null or a non-empty string")
        for field in ("ref", "commit_sha"):
            if item.get(field) is not None and not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be null or a non-empty string")

        repo_id = item.get("repository_id")
        if repo_id is not None:
            repo = repo_by_id.get(repo_id)
            if repo is None:
                errors.append(f"{prefix}.repository_id does not resolve")
            else:
                if item.get("ref") != repo.get("ref"):
                    errors.append(f"{prefix}.ref must match its repository record")
                if item.get("commit_sha") != repo.get("commit_sha"):
                    errors.append(f"{prefix}.commit_sha must match its repository record")

        if level in {"CODE_CONFIRMED", "TEST_CONFIRMED", "CI_CONFIRMED"}:
            if repo_id is None or not nonempty(item.get("ref")) or not full_sha(item.get("commit_sha")):
                errors.append(f"{prefix}: {level} requires repository_id, ref, and full commit")
            if not nonempty(item.get("path_or_url")) and not nonempty(item.get("artifact_ref")):
                errors.append(f"{prefix}: {level} requires a path/url or artifact reference")
        if level == "OBSERVED_RUNTIME":
            if not nonempty(item.get("environment")) or not nonempty(item.get("artifact_ref")):
                errors.append(f"{prefix}: OBSERVED_RUNTIME requires environment and artifact_ref")
        if level == "PROVIDER_CONFIRMED" and not (nonempty(item.get("environment")) or nonempty(item.get("artifact_ref"))):
            errors.append(f"{prefix}: PROVIDER_CONFIRMED requires environment or artifact_ref")

    authority = as_object(root.get("authority_map"), "authority_map", errors)
    reject_extra(authority, {"current_reality_evidence_ids", "target_intent_evidence_ids", "governance_evidence_ids", "conflicts"}, "authority_map", errors)
    for field in ("current_reality_evidence_ids", "target_intent_evidence_ids", "governance_evidence_ids"):
        validate_refs(authority.get(field), f"authority_map.{field}", evidence_ids, errors)
    conflict_items = as_list(authority.get("conflicts"), "authority_map.conflicts", errors)
    conflict_ids, conflicts = unique_object_ids(conflict_items, "authority_map.conflicts", errors)
    for index, conflict in enumerate(conflicts):
        prefix = f"authority_map.conflicts[{index}]"
        reject_extra(conflict, {"id", "axis", "status", "claims", "evidence_ids", "blocking", "resolution"}, prefix, errors)
        claims = string_list(conflict.get("claims"), f"{prefix}.claims", errors, nonempty_list=True)
        if len(claims) < 2:
            errors.append(f"{prefix}.claims must contain at least two claims")
        validate_refs(conflict.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors, require=True)
        if conflict.get("axis") not in CONFLICT_AXES:
            errors.append(f"{prefix}.axis is invalid")
        if conflict.get("status") not in CONFLICT_STATUSES:
            errors.append(f"{prefix}.status is invalid")
        if not isinstance(conflict.get("blocking"), bool):
            errors.append(f"{prefix}.blocking must be a boolean")
        if conflict.get("status") == "RESOLVED" and not nonempty(conflict.get("resolution")):
            errors.append(f"{prefix}: RESOLVED conflict requires resolution")
        if conflict.get("status") != "RESOLVED" and conflict.get("resolution") is not None:
            errors.append(f"{prefix}: unresolved conflict must use null resolution")

    product = as_object(root.get("product"), "product", errors)
    reject_extra(product, {"name", "summary", "users", "delivery_state", "environments", "owner_satisfaction"}, "product", errors)
    for field in ("name", "summary"):
        if not nonempty(product.get(field)):
            errors.append(f"product.{field} must be a non-empty string")
    string_list(product.get("users"), "product.users", errors)
    if product.get("delivery_state") not in DELIVERY_STATES:
        errors.append("product.delivery_state is invalid")
    if product.get("owner_satisfaction") not in SATISFACTION_STATES:
        errors.append("product.owner_satisfaction is invalid")
    environments = as_list(product.get("environments"), "product.environments", errors)
    for index, value in enumerate(environments):
        env = as_object(value, f"product.environments[{index}]", errors)
        reject_extra(env, {"name", "type", "status", "evidence_ids"}, f"product.environments[{index}]", errors)
        if not nonempty(env.get("name")):
            errors.append(f"product.environments[{index}].name must be non-empty")
        if env.get("type") not in ENVIRONMENT_TYPES:
            errors.append(f"product.environments[{index}].type is invalid")
        if env.get("status") not in ENVIRONMENT_STATUSES:
            errors.append(f"product.environments[{index}].status is invalid")
        validate_refs(env.get("evidence_ids"), f"product.environments[{index}].evidence_ids", evidence_ids, errors)

    feature_items = as_list(root.get("features"), "features", errors)
    feature_ids, features = unique_object_ids(feature_items, "features", errors)
    for index, feature in enumerate(features):
        prefix = f"features[{index}]"
        reject_extra(feature, {"id", "name", "group", "evidence_state", "owner_disposition", "summary", "evidence_ids", "quality_note"}, prefix, errors)
        state = feature.get("evidence_state")
        disposition = feature.get("owner_disposition")
        if state not in FEATURE_STATES:
            errors.append(f"{prefix}.evidence_state is invalid")
        if disposition not in DISPOSITIONS:
            errors.append(f"{prefix}.owner_disposition is invalid")
        for field in ("name", "group", "summary"):
            if not nonempty(feature.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if not isinstance(feature.get("quality_note"), str):
            errors.append(f"{prefix}.quality_note must be a string")
        refs = validate_refs(feature.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors, require=True)
        levels = {evidence_level_by_id.get(ref) for ref in refs}
        if state == "VERIFIED_LIVE" and not levels.intersection({"OBSERVED_RUNTIME", "PROVIDER_CONFIRMED"}):
            errors.append(f"{prefix} is VERIFIED_LIVE without runtime/provider evidence")
        if state == "VERIFIED_RUNTIME_NONPROD" and "OBSERVED_RUNTIME" not in levels:
            errors.append(f"{prefix} is VERIFIED_RUNTIME_NONPROD without runtime evidence")
        if state == "IMPLEMENTED_TESTED" and not levels.intersection({"TEST_CONFIRMED", "CI_CONFIRMED"}):
            errors.append(f"{prefix} is IMPLEMENTED_TESTED without test/CI evidence")

    architecture = as_object(root.get("architecture"), "architecture", errors)
    reject_extra(architecture, {"summary", "components", "data_stores", "integrations", "deployment", "operations"}, "architecture", errors)
    if not nonempty(architecture.get("summary")):
        errors.append("architecture.summary must be non-empty")
    architecture_ids: set[str] = set()
    for group in ("components", "data_stores", "integrations"):
        values = as_list(architecture.get(group), f"architecture.{group}", errors)
        ids, objects = unique_object_ids(values, f"architecture.{group}", errors)
        duplicate_cross = architecture_ids.intersection(ids)
        if duplicate_cross:
            errors.append("duplicate architecture item ids: " + ", ".join(sorted(duplicate_cross)))
        architecture_ids |= ids
        for index, item in enumerate(objects):
            prefix = f"architecture.{group}[{index}]"
            reject_extra(item, {"id", "name", "summary", "evidence_ids"}, prefix, errors)
            for field in ("name", "summary"):
                if not nonempty(item.get(field)):
                    errors.append(f"{prefix}.{field} must be a non-empty string")
            validate_refs(item.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors)
    for group in ("deployment", "operations"):
        item = as_object(architecture.get(group), f"architecture.{group}", errors)
        reject_extra(item, {"summary", "evidence_ids"}, f"architecture.{group}", errors)
        if not nonempty(item.get("summary")):
            errors.append(f"architecture.{group}.summary must be a non-empty string")
        validate_refs(item.get("evidence_ids"), f"architecture.{group}.evidence_ids", evidence_ids, errors)

    quality = as_object(root.get("quality"), "quality", errors)
    reject_extra(quality, {"checks"}, "quality", errors)
    quality_categories: set[str] = set()
    checks = as_list(quality.get("checks"), "quality.checks", errors)
    for index, value in enumerate(checks):
        prefix = f"quality.checks[{index}]"
        check = as_object(value, prefix, errors)
        reject_extra(check, {"category", "status", "evidence_ids", "notes"}, prefix, errors)
        category = check.get("category")
        if not nonempty(category):
            errors.append(f"{prefix}.category must be non-empty")
        elif category in quality_categories:
            errors.append(f"duplicate quality category: {category}")
        else:
            quality_categories.add(category)
        if category not in QUALITY_CATEGORIES:
            errors.append(f"{prefix}.category is invalid")
        status = check.get("status")
        if status not in QUALITY_STATUSES:
            errors.append(f"{prefix}.status is invalid")
        refs = validate_refs(check.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors)
        if status == "PASS" and not refs:
            errors.append(f"{prefix}: PASS requires evidence")

    decision_items = as_list(as_object(root.get("owner_alignment"), "owner_alignment", errors).get("decisions"), "owner_alignment.decisions", errors)
    decision_ids, decisions = unique_object_ids(decision_items, "owner_alignment.decisions", errors)
    for index, decision in enumerate(decisions):
        prefix = f"owner_alignment.decisions[{index}]"
        reject_extra(decision, {"id", "decision", "disposition", "source", "recorded_at"}, prefix, errors)
        if decision.get("disposition") not in DISPOSITIONS - {"UNDECIDED"}:
            errors.append(f"{prefix}.disposition is invalid")
        for field in ("decision", "source"):
            if not nonempty(decision.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        recorded_at = parse_timezone_iso(decision.get("recorded_at"))
        if recorded_at is None:
            errors.append(f"{prefix}.recorded_at must be timezone-aware ISO-8601")
        elif packet_generated_at is not None and recorded_at > packet_generated_at:
            errors.append(f"{prefix}.recorded_at cannot be later than packet.generated_at")

    alignment = as_object(root.get("owner_alignment"), "owner_alignment", errors)
    reject_extra(alignment, {"questions", "decisions"}, "owner_alignment", errors)
    question_items = as_list(alignment.get("questions"), "owner_alignment.questions", errors)
    question_ids, questions = unique_object_ids(question_items, "owner_alignment.questions", errors)
    for index, question in enumerate(questions):
        prefix = f"owner_alignment.questions[{index}]"
        reject_extra(question, {"id", "decision", "status", "material", "recommended_answer", "owner_answer", "evidence_ids"}, prefix, errors)
        if question.get("status") not in QUESTION_STATUSES:
            errors.append(f"{prefix}.status is invalid")
        for field in ("decision", "recommended_answer"):
            if not nonempty(question.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if question.get("owner_answer") is not None and not nonempty(question.get("owner_answer")):
            errors.append(f"{prefix}.owner_answer must be null or a non-empty string")
        if question.get("status") == "RESOLVED" and not nonempty(question.get("owner_answer")):
            errors.append(f"{prefix}: RESOLVED question requires owner_answer")
        if not isinstance(question.get("material"), bool):
            errors.append(f"{prefix}.material must be a boolean")
        if question.get("material") is True and question.get("status") == "NOT_BLOCKING":
            errors.append(f"{prefix}: a material question cannot be NOT_BLOCKING")
        validate_refs(question.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors)

    gap_items = as_list(root.get("gaps"), "gaps", errors)
    gap_ids, gaps = unique_object_ids(gap_items, "gaps", errors)
    for index, gap in enumerate(gaps):
        prefix = f"gaps[{index}]"
        reject_extra(gap, {"id", "class", "severity", "summary", "evidence_ids", "owner_decision_required", "blocking", "resolution_decision_id", "recommended_resolution"}, prefix, errors)
        validate_refs(gap.get("evidence_ids"), f"{prefix}.evidence_ids", evidence_ids, errors, require=True)
        if gap.get("class") not in GAP_CLASSES:
            errors.append(f"{prefix}.class is invalid")
        if gap.get("severity") not in SEVERITIES:
            errors.append(f"{prefix}.severity is invalid")
        for field in ("summary", "recommended_resolution"):
            if not nonempty(gap.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if not isinstance(gap.get("owner_decision_required"), bool):
            errors.append(f"{prefix}.owner_decision_required must be a boolean")
        if not isinstance(gap.get("blocking"), bool):
            errors.append(f"{prefix}.blocking must be a boolean")
        resolution_id = gap.get("resolution_decision_id")
        if resolution_id is not None and resolution_id not in decision_ids:
            errors.append(f"{prefix}.resolution_decision_id does not resolve")

    readiness = as_object(root.get("handoff_readiness"), "handoff_readiness", errors)
    reject_extra(readiness, {"status", "blocker_ids", "reason"}, "handoff_readiness", errors)
    readiness_status = readiness.get("status")
    if readiness_status not in HANDOFF_STATUSES:
        errors.append(f"handoff_readiness.status must be one of {sorted(HANDOFF_STATUSES)}")
    blocker_refs = string_list(readiness.get("blocker_ids"), "handoff_readiness.blocker_ids", errors)
    if not nonempty(readiness.get("reason")):
        errors.append("handoff_readiness.reason must be a non-empty string")
    resolvable_blockers = gap_ids | conflict_ids | question_ids
    unresolved_blocker_refs = sorted(set(blocker_refs) - resolvable_blockers)
    if unresolved_blocker_refs:
        errors.append("handoff_readiness.blocker_ids do not resolve: " + ", ".join(unresolved_blocker_refs))
    if readiness_status == "READY" and blocker_refs:
        errors.append("READY handoff_readiness cannot contain blocker_ids")
    active_blockers = {
        gap.get("id") for gap in gaps if gap.get("blocking") is True
    } | {
        conflict.get("id") for conflict in conflicts if conflict.get("blocking") is True
    } | {
        question.get("id") for question in questions
        if question.get("material") is True and question.get("status") not in {"RESOLVED", "DELEGATED"}
    }
    active_blockers.discard(None)
    if set(blocker_refs) != active_blockers:
        errors.append(
            "handoff_readiness.blocker_ids must exactly name current blocking gaps, conflicts, and material questions "
            f"(missing={sorted(active_blockers - set(blocker_refs))}, extra={sorted(set(blocker_refs) - active_blockers)})"
        )
    if readiness_status != "READY" and not blocker_refs:
        errors.append(f"{readiness_status} handoff_readiness requires blocker_ids")
    blocker_namespace = list(gap_ids) + list(conflict_ids) + list(question_ids)
    if len(blocker_namespace) != len(set(blocker_namespace)):
        errors.append("gap, conflict, and question IDs must be globally unique")

    if packet_status == "ALIGNED":
        if readiness_status != "READY":
            errors.append("ALIGNED packet requires handoff_readiness READY")
        for index, feature in enumerate(features):
            if feature.get("owner_disposition") == "UNDECIDED":
                errors.append(f"ALIGNED packet cannot leave features[{index}] UNDECIDED")
        for index, conflict in enumerate(conflicts):
            if conflict.get("blocking") is True and conflict.get("status") != "RESOLVED":
                errors.append(f"ALIGNED packet cannot retain blocking unresolved conflict {conflict.get('id')}")
        for index, question in enumerate(questions):
            if question.get("material") is True and question.get("status") not in {"RESOLVED", "DELEGATED"}:
                errors.append(f"ALIGNED packet cannot retain unresolved material question {question.get('id')}")
        for index, gap in enumerate(gaps):
            if gap.get("blocking") is True:
                errors.append(f"ALIGNED packet cannot retain blocking gap {gap.get('id')}")
    if packet_status == "ANALYZED" and readiness_status == "READY":
        errors.append("ANALYZED packet cannot claim handoff readiness READY")
    if packet_status == "BLOCKED" and readiness_status != "BLOCKED":
        errors.append("BLOCKED packet requires handoff_readiness BLOCKED")

    recommendation = as_object(root.get("recommendation"), "recommendation", errors)
    reject_extra(recommendation, {"engagement_types", "handoff_profiles", "read_first", "next_action"}, "recommendation", errors)
    engagements = string_list(recommendation.get("engagement_types"), "recommendation.engagement_types", errors, nonempty_list=True)
    profiles = string_list(recommendation.get("handoff_profiles"), "recommendation.handoff_profiles", errors, nonempty_list=True)
    if set(engagements) - ENGAGEMENT_TYPES:
        errors.append("recommendation.engagement_types contains an invalid value")
    if set(profiles) - HANDOFF_PROFILES:
        errors.append("recommendation.handoff_profiles contains an invalid value")
    for field in ("read_first", "next_action"):
        if not nonempty(recommendation.get(field)):
            errors.append(f"recommendation.{field} must be a non-empty string")

    serialized = json.dumps(root, ensure_ascii=False)
    for pattern in SECRET_PATTERNS:
        if pattern.search(serialized):
            errors.append("packet appears to contain an unredacted secret or private key")
            break

    if "LIVE_BASELINE" in modes and not baseline.get("deployment_refs"):
        warnings.append("LIVE_BASELINE has no deployment_refs; confirm that deployed provenance is unavailable and documented")

    summary = {
        "packet_status": packet_status,
        "primary_commit": baseline.get("commit_sha"),
        "repository_count": len(repos),
        "feature_count": len(features),
        "gap_count": len(gaps),
        "evidence_count": len(evidence),
        "handoff_readiness": readiness_status,
    }
    return errors, warnings, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet", type=Path)
    parser.add_argument("--current-primary-sha")
    args = parser.parse_args()
    try:
        data = load_json(args.packet)
    except ValueError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    errors, warnings, summary = validate(data, args.current_primary_sha)
    for warning in warnings:
        print(f"WARN: {warning}")
    if errors:
        print("FAIL repository intelligence packet validation", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("PASS repository intelligence packet validation")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
