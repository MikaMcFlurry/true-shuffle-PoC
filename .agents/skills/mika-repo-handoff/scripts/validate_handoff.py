#!/usr/bin/env python3
"""Validate a Mika V2 repository handoff against its bound intelligence packet."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


CORE_ROLES = {
    "agent_entry",
    "start_here",
    "mission",
    "current_state",
    "product_truth",
    "feature_inventory",
    "architecture_runtime",
    "run_deploy_operations",
    "quality_risks",
    "owner_decisions",
    "intelligence_markdown",
    "intelligence_json",
    "evidence_manifest",
}
PROFILE_ROLES = {
    "LIVE_SYSTEM": "production_baseline",
    "MULTI_REPO": "related_repositories",
    "GOVERNED": "governance",
}
ACTIVE = {"CREATE", "UPDATE", "LINK", "AMEND"}
MUTATING = {"CREATE", "UPDATE", "AMEND"}
AUTHORITIES = {"CANONICAL", "SUPPORTING", "GENERATED_VIEW", "HISTORICAL"}
SHA_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
PLACEHOLDER_RE = re.compile(r"\{\{[^}]+\}\}|\b(?:TBD|TODO|CHANGEME)\b|<(?:REPLACE|FILL)[^>\n]*>", re.IGNORECASE)
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[opusr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-(?:live|test|proj)?-?[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"),
]


def load_json(path: Path, errors: list[str], label: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{label}: missing file {path}")
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label}: cannot parse {path}: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{label}: root must be an object")
        return None
    return value


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def is_iso_datetime(value: Any) -> bool:
    return parse_iso_datetime(value) is not None


def safe_rel(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip() or "\\" in value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", "..", ".git", ".hg", ".svn"} for part in path.parts):
        return None
    return path.as_posix()


def contained_path(repo: Path, rel: str, label: str, errors: list[str]) -> Path | None:
    candidate = repo / rel
    try:
        candidate.resolve(strict=False).relative_to(repo)
    except (OSError, ValueError):
        errors.append(f"{label}: path escapes repository through a symlink: {rel}")
        return None
    return candidate


def require_keys(obj: dict[str, Any], required: set[str], allowed: set[str], where: str, errors: list[str]) -> None:
    missing = sorted(required - obj.keys())
    extra = sorted(obj.keys() - allowed)
    if missing:
        errors.append(f"{where}: missing keys {', '.join(missing)}")
    if extra:
        errors.append(f"{where}: unexpected keys {', '.join(extra)}")


def string_list(value: Any, where: str, errors: list[str], *, nonempty: bool = False) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        errors.append(f"{where}: expected a list of non-empty strings")
        return []
    if nonempty and not value:
        errors.append(f"{where}: must not be empty")
    if len(value) != len(set(value)):
        errors.append(f"{where}: duplicate values are not allowed")
    return value


def validate_map(data: dict[str, Any], actual_map_rel: str, errors: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    top = {"schema_version", "generated_at", "map_path", "profiles", "analysis_baseline", "write_scope", "roles"}
    require_keys(data, top, top, "handoff map", errors)
    if data.get("schema_version") != "mika.repo-handoff-map.v2":
        errors.append("handoff map: schema_version must be mika.repo-handoff-map.v2")
    if not is_iso_datetime(data.get("generated_at")):
        errors.append("handoff map: generated_at must be an ISO 8601 timestamp")
    if data.get("map_path") != actual_map_rel:
        errors.append(f"handoff map: map_path must equal actual path {actual_map_rel!r}")

    profiles = string_list(data.get("profiles"), "handoff map.profiles", errors, nonempty=True)
    allowed_profiles = {"LEAN", "STANDARD", "LIVE_SYSTEM", "GOVERNED", "MULTI_REPO"}
    if set(profiles) - allowed_profiles:
        errors.append("handoff map.profiles: contains unsupported profile")

    baseline = data.get("analysis_baseline")
    if not isinstance(baseline, dict):
        errors.append("handoff map.analysis_baseline: expected object")
        baseline = {}
    else:
        keys = {"repository_id", "repository", "ref", "commit_sha", "intelligence_schema", "intelligence_status", "packet_sha256"}
        require_keys(baseline, keys, keys, "handoff map.analysis_baseline", errors)
        for key in ("repository_id", "repository", "ref"):
            if not isinstance(baseline.get(key), str) or not baseline[key]:
                errors.append(f"handoff map.analysis_baseline.{key}: expected non-empty string")
        if not SHA_RE.fullmatch(str(baseline.get("commit_sha", ""))):
            errors.append("handoff map.analysis_baseline.commit_sha: expected full 40- or 64-character SHA")
        if baseline.get("intelligence_schema") != "mika.repository-intelligence.v2":
            errors.append("handoff map.analysis_baseline.intelligence_schema: must be mika.repository-intelligence.v2")
        if baseline.get("intelligence_status") != "ALIGNED":
            errors.append("handoff map.analysis_baseline.intelligence_status: must be ALIGNED")
        if not SHA256_RE.fullmatch(str(baseline.get("packet_sha256", ""))):
            errors.append("handoff map.analysis_baseline.packet_sha256: expected SHA-256")

    scope = data.get("write_scope")
    if not isinstance(scope, dict):
        errors.append("handoff map.write_scope: expected object")
        scope = {}
    else:
        keys = {"base_commit", "branch", "allowed_paths"}
        require_keys(scope, keys, keys, "handoff map.write_scope", errors)
        if str(scope.get("base_commit", "")).lower() != str(baseline.get("commit_sha", "")).lower():
            errors.append("handoff map.write_scope.base_commit: must equal analysis baseline commit")
        if not isinstance(scope.get("branch"), str) or not scope["branch"]:
            errors.append("handoff map.write_scope.branch: expected non-empty string")
        raw_paths = string_list(scope.get("allowed_paths"), "handoff map.write_scope.allowed_paths", errors, nonempty=True)
        normalized = [safe_rel(path) for path in raw_paths]
        if any(path is None for path in normalized):
            errors.append("handoff map.write_scope.allowed_paths: paths must be safe repository-relative POSIX paths")

    roles = data.get("roles")
    if not isinstance(roles, dict):
        errors.append("handoff map.roles: expected object")
        roles = {}
    missing_roles = sorted(CORE_ROLES - roles.keys())
    if missing_roles:
        errors.append(f"handoff map.roles: missing core roles {', '.join(missing_roles)}")
    role_keys = {"path", "treatment", "authority", "reason", "evidence_ids", "owner_decision_ids", "freshness_trigger"}
    mutating_paths = {actual_map_rel}
    for name, role in roles.items():
        where = f"handoff map.roles.{name}"
        if not isinstance(role, dict):
            errors.append(f"{where}: expected object")
            continue
        require_keys(role, role_keys, role_keys, where, errors)
        treatment = role.get("treatment")
        if name in CORE_ROLES and treatment not in ACTIVE:
            errors.append(f"{where}.treatment: core role must be active")
        elif treatment not in ACTIVE | {"SKIP", "BLOCKED"}:
            errors.append(f"{where}.treatment: unsupported treatment")
        path = safe_rel(role.get("path")) if role.get("path") is not None else None
        if treatment in ACTIVE and path is None:
            errors.append(f"{where}.path: active role requires a safe repository-relative path")
        if treatment in MUTATING and path:
            mutating_paths.add(path)
        authority = role.get("authority")
        if treatment in ACTIVE and authority not in AUTHORITIES:
            errors.append(f"{where}.authority: active role requires a supported authority")
        if treatment in {"SKIP", "BLOCKED"} and authority != "NONE":
            errors.append(f"{where}.authority: inactive role must use NONE")
        if not isinstance(role.get("reason"), str) or not role["reason"]:
            errors.append(f"{where}.reason: expected non-empty string")
        string_list(role.get("evidence_ids"), f"{where}.evidence_ids", errors)
        string_list(role.get("owner_decision_ids"), f"{where}.owner_decision_ids", errors)
        if treatment in ACTIVE and not role.get("evidence_ids") and not role.get("owner_decision_ids"):
            errors.append(f"{where}: active role requires at least one evidence or owner-decision ID")
        if not isinstance(role.get("freshness_trigger"), str) or not role["freshness_trigger"]:
            errors.append(f"{where}.freshness_trigger: expected non-empty string")

    for profile, required_role in PROFILE_ROLES.items():
        if profile in profiles:
            role = roles.get(required_role)
            if not isinstance(role, dict) or role.get("treatment") not in ACTIVE:
                errors.append(f"handoff map.roles: profile {profile} requires active role {required_role}")

    allowed_paths = set(scope.get("allowed_paths", [])) if isinstance(scope.get("allowed_paths"), list) else set()
    if allowed_paths != mutating_paths:
        errors.append(
            "handoff map.write_scope.allowed_paths: must exactly equal the map plus CREATE/UPDATE/AMEND role paths "
            f"(missing={sorted(mutating_paths - allowed_paths)}, extra={sorted(allowed_paths - mutating_paths)})"
        )
    return baseline, roles


def collect_packet_ids(packet: dict[str, Any]) -> tuple[set[str], set[str]]:
    evidence_ids = {
        item.get("id") for item in packet.get("evidence", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    decision_ids = {
        item.get("id") for item in packet.get("owner_alignment", {}).get("decisions", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    return evidence_ids, decision_ids


def validate_packet_binding(repo: Path, baseline: dict[str, Any], roles: dict[str, Any], map_generated_at: Any, errors: list[str]) -> tuple[dict[str, Any] | None, Path | None]:
    role = roles.get("intelligence_json")
    if not isinstance(role, dict) or safe_rel(role.get("path")) is None:
        errors.append("packet binding: intelligence_json role has no safe active path")
        return None, None
    packet_path = contained_path(repo, role["path"], "packet binding", errors)
    if packet_path is None:
        return None, None
    packet = load_json(packet_path, errors, "intelligence packet")
    if packet is None:
        return None, packet_path
    digest = hashlib.sha256(packet_path.read_bytes()).hexdigest()
    if digest.lower() != str(baseline.get("packet_sha256", "")).lower():
        errors.append("packet binding: packet_sha256 does not match packet bytes")
    if packet.get("schema_version") != "mika.repository-intelligence.v2":
        errors.append("packet binding: intelligence schema must be mika.repository-intelligence.v2")
    if packet.get("packet_status") != "ALIGNED":
        errors.append("packet binding: packet status must be ALIGNED")
    packet_generated = parse_iso_datetime(packet.get("generated_at"))
    map_generated = parse_iso_datetime(map_generated_at)
    if packet_generated is None:
        errors.append("packet binding: packet generated_at must be timezone-aware ISO 8601")
    elif map_generated is not None and map_generated < packet_generated:
        errors.append("packet binding: handoff map cannot predate the intelligence packet")
    readiness = packet.get("handoff_readiness", {})
    if not isinstance(readiness, dict) or readiness.get("status") != "READY" or readiness.get("blocker_ids"):
        errors.append("packet binding: handoff_readiness must be READY with no blocker IDs")
    primary = packet.get("primary_baseline", {})
    repositories = packet.get("repositories", [])
    primary_repo = next(
        (item for item in repositories if isinstance(item, dict) and item.get("id") == primary.get("repository_id")),
        {},
    )
    comparisons = {
        "repository_id": primary.get("repository_id"),
        "ref": primary.get("ref"),
        "repository": primary_repo.get("full_name"),
    }
    for key, actual in comparisons.items():
        if baseline.get(key) != actual:
            errors.append(f"packet binding: analysis_baseline.{key} does not match intelligence packet")
    if str(baseline.get("commit_sha", "")).lower() != str(primary.get("commit_sha", "")).lower():
        errors.append("packet binding: analysis_baseline.commit_sha does not match intelligence packet")
    return packet, packet_path


def validate_manifest(repo: Path, baseline: dict[str, Any], roles: dict[str, Any], packet: dict[str, Any] | None, map_generated_at: Any, errors: list[str]) -> Path | None:
    manifest_role = roles.get("evidence_manifest")
    if not isinstance(manifest_role, dict) or safe_rel(manifest_role.get("path")) is None:
        errors.append("evidence manifest: evidence_manifest role has no safe active path")
        return None
    path = contained_path(repo, manifest_role["path"], "evidence manifest", errors)
    if path is None:
        return None
    manifest = load_json(path, errors, "evidence manifest")
    if manifest is None:
        return path
    top = {"schema_version", "generated_at", "analysis_baseline", "packet_sha256", "artifacts"}
    require_keys(manifest, top, top, "evidence manifest", errors)
    if manifest.get("schema_version") != "mika.repo-handoff-evidence.v2":
        errors.append("evidence manifest: schema_version must be mika.repo-handoff-evidence.v2")
    if not is_iso_datetime(manifest.get("generated_at")):
        errors.append("evidence manifest: generated_at must be an ISO 8601 timestamp")
    else:
        manifest_generated = parse_iso_datetime(manifest.get("generated_at"))
        packet_generated = parse_iso_datetime((packet or {}).get("generated_at"))
        map_generated = parse_iso_datetime(map_generated_at)
        if packet_generated is not None and manifest_generated is not None and manifest_generated < packet_generated:
            errors.append("evidence manifest: cannot predate the intelligence packet")
        if map_generated is not None and manifest_generated is not None and manifest_generated < map_generated:
            errors.append("evidence manifest: cannot predate the Handoff Map")
    manifest_baseline = manifest.get("analysis_baseline")
    expected_baseline = {key: baseline.get(key) for key in ("repository_id", "ref", "commit_sha")}
    if manifest_baseline != expected_baseline:
        errors.append("evidence manifest: analysis_baseline must exactly match handoff map")
    if manifest.get("packet_sha256") != baseline.get("packet_sha256"):
        errors.append("evidence manifest: packet_sha256 must match handoff map")

    evidence_ids, decision_ids = collect_packet_ids(packet or {})
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("evidence manifest.artifacts: expected a non-empty array")
        artifacts = []
    coverage: set[str] = set()
    seen_pairs: set[tuple[str, str]] = set()
    artifact_keys = {"path", "roles", "treatment", "authority", "evidence_ids", "owner_decision_ids", "freshness_trigger"}
    for index, artifact in enumerate(artifacts):
        where = f"evidence manifest.artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{where}: expected object")
            continue
        require_keys(artifact, artifact_keys, artifact_keys, where, errors)
        artifact_path = safe_rel(artifact.get("path"))
        if artifact_path is None:
            errors.append(f"{where}.path: expected safe repository-relative path")
        artifact_roles = string_list(artifact.get("roles"), f"{where}.roles", errors, nonempty=True)
        refs = string_list(artifact.get("evidence_ids"), f"{where}.evidence_ids", errors)
        decisions = string_list(artifact.get("owner_decision_ids"), f"{where}.owner_decision_ids", errors)
        if set(refs) - evidence_ids:
            errors.append(f"{where}.evidence_ids: unknown IDs {sorted(set(refs) - evidence_ids)}")
        if set(decisions) - decision_ids:
            errors.append(f"{where}.owner_decision_ids: unknown IDs {sorted(set(decisions) - decision_ids)}")
        if artifact.get("treatment") not in ACTIVE:
            errors.append(f"{where}.treatment: expected active treatment")
        if artifact.get("authority") not in AUTHORITIES:
            errors.append(f"{where}.authority: unsupported authority")
        if not isinstance(artifact.get("freshness_trigger"), str) or not artifact["freshness_trigger"]:
            errors.append(f"{where}.freshness_trigger: expected non-empty string")
        for role_name in artifact_roles:
            key = (artifact_path or "", role_name)
            if key in seen_pairs:
                errors.append(f"{where}: duplicate path/role pair {key}")
            seen_pairs.add(key)
            mapped = roles.get(role_name)
            if not isinstance(mapped, dict):
                errors.append(f"{where}.roles: unknown role {role_name}")
                continue
            coverage.add(role_name)
            for field in ("path", "treatment", "authority", "freshness_trigger"):
                if artifact.get(field) != mapped.get(field):
                    errors.append(f"{where}: {field} does not match mapped role {role_name}")
            if set(refs) != set(mapped.get("evidence_ids", [])):
                errors.append(f"{where}: evidence_ids do not match mapped role {role_name}")
            if set(decisions) != set(mapped.get("owner_decision_ids", [])):
                errors.append(f"{where}: owner_decision_ids do not match mapped role {role_name}")
    active_roles = {name for name, role in roles.items() if isinstance(role, dict) and role.get("treatment") in ACTIVE}
    if coverage != active_roles:
        errors.append(f"evidence manifest: role coverage mismatch (missing={sorted(active_roles - coverage)}, extra={sorted(coverage - active_roles)})")
    return path


def scan_artifacts(repo: Path, actual_map_rel: str, roles: dict[str, Any], max_agent_lines: int, errors: list[str]) -> None:
    active_paths: set[str] = set()
    for role in roles.values():
        if isinstance(role, dict) and role.get("treatment") in ACTIVE and safe_rel(role.get("path")):
            active_paths.add(role["path"])
    for rel in sorted(active_paths):
        path = contained_path(repo, rel, "artifact", errors)
        if path is not None and not path.is_file():
            errors.append(f"artifact: mapped active path does not exist: {rel}")

    paths = {actual_map_rel}
    for role in roles.values():
        if isinstance(role, dict) and role.get("treatment") in MUTATING and safe_rel(role.get("path")):
            paths.add(role["path"])
    for rel in sorted(paths):
        path = contained_path(repo, rel, "artifact", errors)
        if path is None:
            continue
        if not path.is_file():
            errors.append(f"artifact: mapped mutating path does not exist: {rel}")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"artifact: cannot read {rel}: {exc}")
            continue
        if PLACEHOLDER_RE.search(text):
            errors.append(f"artifact: unresolved placeholder in {rel}")
        if any(pattern.search(text) for pattern in SECRET_PATTERNS):
            errors.append(f"artifact: possible secret in {rel}")

    agent = roles.get("agent_entry", {})
    if isinstance(agent, dict) and agent.get("treatment") in ACTIVE and safe_rel(agent.get("path")):
        agent_path = contained_path(repo, agent["path"], "agent entry", errors)
        if agent_path is None:
            return
        if agent_path.is_file():
            text = agent_path.read_text(encoding="utf-8")
            lines = text.splitlines()
            if agent.get("treatment") in MUTATING and len(lines) > max_agent_lines:
                errors.append(f"agent entry: {agent['path']} has {len(lines)} lines; maximum is {max_agent_lines}")
            start = roles.get("start_here", {})
            required_mentions = [actual_map_rel]
            if isinstance(start, dict) and safe_rel(start.get("path")):
                required_mentions.append(start["path"])
            present = [mention for mention in required_mentions if mention in text or Path(mention).name in text]
            if agent.get("treatment") in MUTATING:
                for mention in required_mentions:
                    if mention not in present:
                        errors.append(f"agent entry: does not route to {mention}")
            elif not present:
                errors.append("agent entry: linked canonical entrypoint does not route to the map or start role")


def git_output(repo: Path, args: list[str], errors: list[str]) -> str | None:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        errors.append(f"git {' '.join(args)}: {result.stderr.strip() or 'command failed'}")
        return None
    return result.stdout.strip()


def validate_git(repo: Path, baseline: dict[str, Any], scope: dict[str, Any], errors: list[str]) -> None:
    inside = git_output(repo, ["rev-parse", "--is-inside-work-tree"], errors)
    if inside != "true":
        errors.append("git check: repository is not a Git worktree")
        return
    base = str(scope.get("base_commit", ""))
    resolved = git_output(repo, ["rev-parse", "--verify", f"{base}^{{commit}}"], errors)
    if resolved and resolved.lower() != str(baseline.get("commit_sha", "")).lower():
        errors.append("git check: resolved base commit differs from analysis baseline")
    ancestor = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", base, "HEAD"])
    if ancestor.returncode:
        errors.append("git check: base commit is not an ancestor of HEAD")
    branch = git_output(repo, ["branch", "--show-current"], errors)
    if branch != scope.get("branch"):
        errors.append(f"git check: current branch {branch!r} differs from mapped branch {scope.get('branch')!r}")
    tracked = git_output(repo, ["diff", "--name-only", base, "--"], errors)
    untracked = git_output(repo, ["ls-files", "--others", "--exclude-standard"], errors)
    changed = {line for output in (tracked, untracked) if output for line in output.splitlines() if line}
    allowed = set(scope.get("allowed_paths", []))
    unexpected = sorted(changed - allowed)
    if unexpected:
        errors.append(f"git check: changed paths outside write allowlist: {', '.join(unexpected)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path, help="Repository root")
    parser.add_argument("--map", dest="map_path", default="docs/ai-dev/HANDOFF_MAP.json", help="Repository-relative Handoff Map path")
    parser.add_argument("--max-agent-lines", type=int, default=220)
    parser.add_argument("--git-check", action="store_true", help="Check baseline ancestry, branch, and changed-path allowlist")
    args = parser.parse_args()

    repo = args.repository.resolve()
    errors: list[str] = []
    map_rel = safe_rel(args.map_path)
    if not repo.is_dir():
        errors.append(f"repository: not a directory: {repo}")
    if map_rel is None:
        errors.append("--map: expected a safe repository-relative POSIX path")
        map_rel = args.map_path
    map_file = contained_path(repo, map_rel, "handoff map", errors) if repo.is_dir() else None
    map_data = load_json(map_file, errors, "handoff map") if map_file is not None else None
    baseline: dict[str, Any] = {}
    roles: dict[str, Any] = {}
    if map_data is not None:
        baseline, roles = validate_map(map_data, map_rel, errors)
        packet, _ = validate_packet_binding(repo, baseline, roles, map_data.get("generated_at"), errors)
        validate_manifest(repo, baseline, roles, packet, map_data.get("generated_at"), errors)
        scan_artifacts(repo, map_rel, roles, args.max_agent_lines, errors)
        if args.git_check:
            validate_git(repo, baseline, map_data.get("write_scope", {}), errors)

    if errors:
        print("FAIL: repository handoff validation")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"PASS: repository handoff validated ({len(roles)} roles, baseline {baseline.get('commit_sha')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
