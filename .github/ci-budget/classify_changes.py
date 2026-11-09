#!/usr/bin/env python3
"""Klassifiziert geänderte Dateien und leitet daraus Job-Schalter für GitHub Actions ab.

Nur Standardbibliothek. Konfiguration: JSON nach assets/ci-budget.example.json.

Beispiele:
  python classify_changes.py --config .github/ci-budget.json --base "$BASE" --head "$HEAD"
  git diff --name-only A...B | python classify_changes.py --config cfg.json --stdin
  python classify_changes.py --config cfg.json --files a.md b.ts --event pull_request

Ausgabe: JSON auf stdout; zusätzlich `key=value`-Zeilen nach $GITHUB_OUTPUT, falls gesetzt:
  plan=<json {job: bool}>, mode=<docs_only|selective|full>, reason=<text>, <job>=true|false
Sicherheitsprinzip: Unklare Lage (unbekannte Pfade, fehlende Basis, Git-Fehler) ⇒ Vollprüfung.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from functools import lru_cache
from typing import Iterable

ZERO_SHA = re.compile(r"^0+$")


@lru_cache(maxsize=None)
def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Glob mit `**` (beliebig tief), `*` (ohne `/`) und `?`.

    Muster ohne `/` passen auf jeden Basisnamen; ein führendes `/` verankert am Repo-Root.
    """
    if pattern.startswith("/"):
        pattern = pattern[1:]
    elif "/" not in pattern:
        pattern = "**/" + pattern
    i, out = 0, []
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def matches(path: str, patterns: Iterable[str]) -> bool:
    return any(glob_to_regex(p).match(path) for p in patterns)


def validate_config(cfg: dict) -> list[str]:
    errors = []
    if cfg.get("version") != 1:
        errors.append("version muss 1 sein")
    cats = cfg.get("categories")
    if not isinstance(cats, dict) or not cats:
        errors.append("categories fehlt oder leer")
        cats = {}
    for key in ("docs_categories", "full_categories"):
        for c in cfg.get(key, []):
            if c not in cats:
                errors.append(f"{key}: unbekannte Kategorie {c!r}")
    jobs = cfg.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        errors.append("jobs fehlt oder leer")
        jobs = {}
    for name, job in jobs.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", name):
            errors.append(f"ungültiger Jobname {name!r}")
        for c in job.get("when_any", []):
            if c not in cats:
                errors.append(f"jobs.{name}.when_any: unbekannte Kategorie {c!r}")
    if cfg.get("unknown", "full") not in ("full", "ignore"):
        errors.append("unknown muss 'full' oder 'ignore' sein")
    return errors


def classify(files: list[str], cfg: dict, event: str = "", force_full: bool = False, full_reason: str = "") -> dict:
    cats: dict[str, list[str]] = cfg["categories"]
    jobs: dict[str, dict] = cfg["jobs"]
    hit: dict[str, list[str]] = {}
    unknown: list[str] = []
    for f in files:
        f = f.strip().replace("\\", "/")
        if not f:
            continue
        found = [name for name, pats in cats.items() if matches(f, pats)]
        if not found:
            unknown.append(f)
        for name in found:
            hit.setdefault(name, []).append(f)

    reason = full_reason
    full = force_full
    if not full and event in cfg.get("full_events", []):
        full, reason = True, f"Event {event} verlangt Vollprüfung"
    if not full:
        full_hits = [c for c in cfg.get("full_categories", []) if c in hit]
        if full_hits:
            full, reason = True, "gemeinsame Konfiguration/Lockfile geändert: " + ", ".join(full_hits)
    if not full and unknown and cfg.get("unknown", "full") == "full":
        full, reason = True, f"{len(unknown)} Datei(en) ohne Kategorie, z. B. {unknown[0]}"
    if not full and not files:
        full, reason = True, "keine Dateiliste ermittelt"

    if full:
        plan = {name: True for name in jobs}
        mode = "full"
    else:
        docs = set(cfg.get("docs_categories", []))
        non_docs = [c for c in hit if c not in docs]
        plan = {name: any(c in hit for c in job.get("when_any", [])) for name, job in jobs.items()}
        if not non_docs and not unknown:
            mode = "docs_only"
            reason = reason or "nur Dokumentation geändert"
        else:
            mode = "selective"
            reason = reason or "betroffen: " + ", ".join(sorted(non_docs))
    return {
        "mode": mode,
        "reason": reason,
        "plan": plan,
        "categories": {k: len(v) for k, v in sorted(hit.items())},
        "unknown": unknown[:20],
        "file_count": len(files),
    }


def git_diff(base: str, head: str) -> list[str] | None:
    if not base or not head or ZERO_SHA.match(base):
        return None
    for spec in (f"{base}...{head}", f"{base}..{head}"):
        r = subprocess.run(["git", "diff", "--name-only", spec], capture_output=True, text=True)
        if r.returncode == 0:
            return [line for line in r.stdout.splitlines() if line.strip()]
    return None


def write_github_output(result: dict, path: str) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"plan={json.dumps(result['plan'], separators=(',', ':'))}\n")
        fh.write(f"mode={result['mode']}\n")
        fh.write("reason=" + result["reason"].replace("\n", " ") + "\n")
        for job, on in result["plan"].items():
            fh.write(f"{job}={'true' if on else 'false'}\n")


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--files", nargs="*")
    src.add_argument("--stdin", action="store_true")
    ap.add_argument("--base", default="")
    ap.add_argument("--head", default="")
    ap.add_argument("--event", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    ap.add_argument("--full", action="store_true", help="Vollprüfung erzwingen")
    ap.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)
    errors = validate_config(cfg)
    if errors:
        print("Konfigurationsfehler:\n- " + "\n- ".join(errors), file=sys.stderr)
        return 2

    full_reason = "Vollprüfung angefordert" if args.full else ""
    if args.files is not None:
        files = args.files
    elif args.stdin:
        files = sys.stdin.read().splitlines()
    else:
        diff = git_diff(args.base, args.head)
        if diff is None:
            files, args.full = [], True
            full_reason = "Vergleichsbasis nicht ermittelbar (neuer Branch oder fehlende Historie)"
        else:
            files = diff

    result = classify(files, cfg, event=args.event, force_full=args.full, full_reason=full_reason)
    if args.github_output:
        write_github_output(result, args.github_output)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
