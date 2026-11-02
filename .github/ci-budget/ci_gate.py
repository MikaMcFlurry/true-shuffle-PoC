#!/usr/bin/env python3
"""Ehrliches Abschlussgate für selektive GitHub-Actions-Jobs.

Gedacht für einen Job mit `if: always()` und `needs: [...]`, der als einziger Required Check dient.
Ein per `if` übersprungener Job erscheint in Branch-Protection sonst als Erfolg; dieses Gate prüft,
ob das Überspringen laut Plan erlaubt war.

  NEEDS_JSON='${{ toJSON(needs) }}' PLAN_JSON='${{ needs.changes.outputs.plan }}' \
    python ci_gate.py --always-required changes

Regeln je Job aus `needs`:
  success                       -> ok
  failure | cancelled           -> FAIL
  skipped und laut Plan nötig   -> FAIL (fehlende Prüfung ist kein PASS)
  skipped und laut Plan unnötig -> ok (bewusst ausgelassen)
  unbekannter Status            -> FAIL
Plan-Jobs, die in `needs` fehlen, sind ein Konfigurationsfehler -> FAIL.
Fehlt oder ist der Plan unlesbar, gilt jeder Job als nötig.
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def evaluate(needs: dict, plan: dict | None, always_required: set[str]) -> tuple[bool, list[dict]]:
    rows = []
    ok = True
    for job, info in sorted(needs.items()):
        result = (info or {}).get("result", "unknown")
        required = job in always_required or plan is None or bool(plan.get(job, True))
        if result == "success":
            verdict = "PASS"
        elif result == "skipped" and not required:
            verdict = "SKIPPED_OK"
        elif result == "skipped":
            verdict = "FAIL_MISSING"
        else:
            verdict = "FAIL"
        if verdict.startswith("FAIL"):
            ok = False
        rows.append({"job": job, "result": result, "required": required, "verdict": verdict})
    for job in sorted((plan or {}).keys()):
        if job not in needs:
            ok = False
            rows.append({"job": job, "result": "absent", "required": True, "verdict": "FAIL_NOT_WIRED"})
    if not needs:
        ok = False
        rows.append({"job": "-", "result": "no needs", "required": True, "verdict": "FAIL_EMPTY"})
    return ok, rows


def render(ok: bool, rows: list[dict]) -> str:
    lines = [f"### CI-Gate: {'PASS' if ok else 'FAIL'}", "", "| Job | Ergebnis | nötig | Urteil |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['job']} | {r['result']} | {'ja' if r['required'] else 'nein'} | {r['verdict']} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--needs-json", default=os.environ.get("NEEDS_JSON", ""))
    ap.add_argument("--plan-json", default=os.environ.get("PLAN_JSON", ""))
    ap.add_argument("--always-required", nargs="*", default=[])
    args = ap.parse_args(argv)

    try:
        needs = json.loads(args.needs_json) if args.needs_json else {}
    except json.JSONDecodeError as e:
        print(f"needs-JSON unlesbar: {e}", file=sys.stderr)
        return 1
    try:
        plan = json.loads(args.plan_json) if args.plan_json else None
        if plan is not None and not isinstance(plan, dict):
            plan = None
    except json.JSONDecodeError:
        plan = None  # konservativ: alles nötig

    ok, rows = evaluate(needs, plan, set(args.always_required))
    report = render(ok, rows)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
