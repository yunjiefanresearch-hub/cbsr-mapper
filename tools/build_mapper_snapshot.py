#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_mapper_snapshot.py — regenerate the CBSR mapper's bundled DATA snapshot
from the register, so the public surface can never assert a state the register
has retracted.

WHY THIS EXISTS
---------------
The mapper (2-cbsr-mapper/src/App.jsx) carries a hand-pasted `const DATA = {...}`
snapshot. At the time of writing it was pinned to register v0.10.1 and published
`citable_count: 46` with a per-record boolean `citable: true`.

The register at v0.11.0 says something materially different:

    citable_subset.count                 = 46   (STRUCTURAL CANDIDATES ONLY)
    decision_ready_citable_subset.count  = 0    (THE PUBLIC GATE)
    freshness.counts                     = {current: 0, stale: 38, unknown: 114}
    review_coverage.second_reviewer      = 0

So the mapper's "citable law only" toggle was projecting 46 records as citable
law that the register itself does not treat as decision-ready. For a project
whose entire claim is evidence discipline, that is the most damaging possible
defect. This script removes the class of defect, not just the instance.

WHAT IT EMITS
-------------
A JS module fragment containing the DATA constant with:
  * the three orthogonal evidence axes the mapper already had
    (claim_class / evidence_tier / binding_status), plus
  * the three axes v0.11.0 added and the mapper never learned:
    source_disposition / review_status / review_stage
  * `citable` REPLACED by two explicit fields:
      - `structural_candidate` (the old, weaker 46-record filter)
      - `decision_ready`       (the strict public gate; currently 0)
  * a meta block carrying BOTH counts and the freshness census, so the UI can
    render "0 decision-ready of 46 structural candidates" rather than "46".

USAGE
-----
    python build_mapper_snapshot.py \
        --register /path/to/cross-border-stablecoin-register \
        --out      /path/to/cbsr-mapper/src/data.snapshot.js

    # verify the committed snapshot still matches the register (CI gate):
    python build_mapper_snapshot.py --register ... --out ... --check

Exit code 3 on --check mismatch, so it can be wired into the mapper's
`npm run check` alongside scripts/check-invariants.mjs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCHEMA = "cbsr/mapper-snapshot/v2"

# The strict public gate. Mirrors dataset.json:decision_ready_citable_subset.filter.
# Kept here explicitly rather than read from the file so that a silent widening
# of the register-side filter shows up as a diff in review.
DECISION_READY_GATE = {
    "claim_class": "tier1_legal",
    "status": "in_force",
    "evidence_tier": "resolution_text",
    "source_disposition": "official",
    "review_status": "current",
    "review_stage": "reconciled",
}

STRUCTURAL_GATE = {
    "claim_class": "tier1_legal",
    "status": "in_force",
    "evidence_tier": "resolution_text",
}


def _matches(record: dict, gate: dict) -> bool:
    freshness = record.get("freshness") or {}
    for key, expected in gate.items():
        value = record.get(key)
        if value is None and key in freshness:
            value = freshness.get(key)
        if value != expected:
            return False
    return True


def _project_record(record: dict) -> dict:
    """One register record -> one mapper record. No new facts are introduced."""
    source = record.get("source") or {}
    freshness = record.get("freshness") or {}
    return {
        "id": record.get("id"),
        "jur": record.get("jurisdiction"),
        "authority": record.get("authority") or "",
        "instrument_label_local": record.get("instrument_label_local") or "",
        "dimension": record.get("dimension"),
        "constraint_ref": record.get("constraint_ref"),
        "requirement_summary": record.get("requirement_summary") or "",
        "status": record.get("status"),
        "source_primary": source.get("primary") or "",
        "pinpoint": source.get("pinpoint") or "",
        "url": source.get("url") or "",
        "interpretation_note": record.get("interpretation_note") or "",
        "tension": record.get("tension") or "",
        "resolution_channel": record.get("resolution_channel") or "",
        "confidence": record.get("confidence"),
        # --- the three axes the mapper already rendered ---
        "claim_class": record.get("claim_class"),
        "evidence_tier": record.get("evidence_tier"),
        "binding_status": record.get("binding_status"),
        # --- the three axes v0.11.0 added; the mapper must learn them ---
        "source_disposition": record.get("source_disposition")
        or freshness.get("source_disposition"),
        "review_status": record.get("review_status") or freshness.get("review_status"),
        "review_stage": record.get("review_stage"),
        # --- the honest split that replaces the old boolean `citable` ---
        "structural_candidate": _matches(record, STRUCTURAL_GATE),
        "decision_ready": _matches(record, DECISION_READY_GATE),
        # --- COMPAT SHIM ---
        # The mapper has ~20 sites reading `rec.citable`. Rather than leave any
        # of them on the old, too-loose meaning while the migration lands, the
        # legacy key is kept and REDEFINED to the strict gate. Every legacy call
        # site therefore becomes honest the moment the snapshot is imported:
        # the "citable law only" toggle, the badge, the CSV/PDF exports and the
        # substrate tally all narrow to decision-ready.
        # Remove this key once no `\.citable` reference remains in src/.
        "citable": _matches(record, DECISION_READY_GATE),
    }


def build(register_dir: Path) -> dict:
    dataset_path = register_dir / "dataset.json"
    if not dataset_path.exists():
        raise SystemExit(
            f"REGISTER NOT FOUND: no dataset.json under {register_dir}\n"
            f"  (looked for {dataset_path})\n"
            "  --register must point at a checkout of cross-border-stablecoin-register.\n"
            "  Locally: clone it as a sibling of cbsr-mapper/, matching the path\n"
            "  package.json's check:snapshot script and DEPLOY.md already use.\n"
            "  In CI: the register repo must be checked out in the same job, as a\n"
            "  sibling directory — see .github/workflows/deploy.yml."
        )
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    records = [_project_record(r) for r in dataset.get("records", [])]

    coverage: dict[str, list[str]] = {}
    for record in records:
        coverage.setdefault(record["jur"], [])
        if record["dimension"] not in coverage[record["jur"]]:
            coverage[record["jur"]].append(record["dimension"])
    for jurisdiction in coverage:
        coverage[jurisdiction].sort()

    freshness = dataset.get("freshness") or {}
    review = dataset.get("review_coverage") or {}
    structural = sum(1 for r in records if r["structural_candidate"])
    decision_ready = sum(1 for r in records if r["decision_ready"])

    # Cross-check against the register's own reported counts. A divergence means
    # the gate encoded above and the gate the build enforces have drifted apart,
    # which is exactly the failure this script exists to catch.
    register_structural = (dataset.get("citable_subset") or {}).get("count")
    register_ready = (dataset.get("decision_ready_citable_subset") or {}).get("count")
    problems = []
    if register_structural is not None and register_structural != structural:
        problems.append(
            f"structural candidates: register={register_structural} computed={structural}"
        )
    if register_ready is not None and register_ready != decision_ready:
        problems.append(
            f"decision-ready: register={register_ready} computed={decision_ready}"
        )
    if problems:
        raise SystemExit(
            "GATE DRIFT — the snapshot gate no longer matches the register build:\n  "
            + "\n  ".join(problems)
        )

    return {
        "schema": SCHEMA,
        "dimensions": _dimensions(register_dir),
        "jurisdictions": _jurisdictions(register_dir),
        "records": records,
        "coverage": coverage,
        "corridors": dataset.get("corridors", []),
        "meta": {
            "name": dataset.get("name"),
            "version": dataset.get("version"),
            "generated": dataset.get("generated"),
            "record_count": dataset.get("record_count"),
            # Two counts, never one. The UI must not be able to render a single
            # "citable" number again.
            "structural_candidate_count": structural,
            "decision_ready_count": decision_ready,
            # COMPAT: the legacy meta key, redefined to the strict gate so that
            # every existing `DATA.meta.citable_count` read reports 0 rather
            # than 46. Remove once no legacy reference remains.
            "citable_count": decision_ready,
            "as_of": dataset.get("generated"),
            "freshness_counts": freshness.get("counts", {}),
            "source_disposition_counts": freshness.get("source_disposition_counts", {}),
            "review_coverage": review,
            "gate": {
                "structural": STRUCTURAL_GATE,
                "decision_ready": DECISION_READY_GATE,
            },
            "reading": (
                "decision_ready_count is the public gate exposed by citable_law(). "
                "structural_candidate_count is an inventory filter and is NOT a "
                "statement that a record may be cited as current binding law."
            ),
        },
    }


def _catalog_dict(register_dir: Path, name: str) -> dict:
    """
    Read a controlled-vocabulary dict out of the register's catalog module.

    Parsed with `ast`, never exec'd: the snapshot build must not be able to run
    arbitrary code from the register tree. Returns {} if the catalog is absent,
    so the mapper can fall back to its own editorial labels.
    """
    import ast

    catalog = register_dir / "src" / "cbsr_mcp" / "core" / "catalog.py"
    if not catalog.exists():
        return {}
    tree = ast.parse(catalog.read_text(encoding="utf-8"))
    for node in tree.body:
        targets = []
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
            value = node.value
        elif isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        else:
            continue
        if name in targets and value is not None:
            try:
                parsed = ast.literal_eval(value)
            except ValueError:
                return {}
            return parsed if isinstance(parsed, dict) else {}
    return {}


def _dimensions(register_dir: Path) -> dict:
    return _catalog_dict(register_dir, "DIMENSIONS")


def _jurisdictions(register_dir: Path) -> dict:
    catalog = _catalog_dict(register_dir, "JURISDICTIONS")
    if catalog:
        return catalog
    meta_path = register_dir / "api" / "meta.json"
    if not meta_path.exists():
        return {}
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    codes = (meta.get("data") or {}).get("jurisdictions", [])
    return {code: code for code in codes}


def render(snapshot: dict) -> str:
    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return (
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n"
        "// Source: cross-border-stablecoin-register/dataset.json\n"
        "// Regenerate: python tools/build_mapper_snapshot.py --register <path> --out src/data.snapshot.js\n"
        "// Verify in CI: same command with --check (exit 3 on drift).\n"
        f"// Register version: {snapshot['meta'].get('version')} "
        f"({snapshot['meta'].get('generated')})\n"
        f"// decision_ready={snapshot['meta'].get('decision_ready_count')} "
        f"structural_candidates={snapshot['meta'].get('structural_candidate_count')}\n"
        f"export const DATA = {body};\n"
        "export default DATA;\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--register", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--check", action="store_true",
                        help="verify the committed snapshot matches; do not write")
    args = parser.parse_args()

    rendered = render(build(args.register))

    if args.check:
        if not args.out.exists():
            print(f"MISSING: {args.out}", file=sys.stderr)
            return 3
        if args.out.read_text(encoding="utf-8") != rendered:
            print(
                "SNAPSHOT DRIFT: the committed mapper snapshot does not match the "
                "register. Run without --check and commit the result.",
                file=sys.stderr,
            )
            return 3
        print("snapshot OK")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(rendered, encoding="utf-8")
    meta = json.loads(rendered.split("export const DATA = ", 1)[1].rsplit(";", 2)[0])["meta"]
    print(
        f"wrote {args.out}  version={meta['version']}  records={meta['record_count']}  "
        f"decision_ready={meta['decision_ready_count']}  "
        f"structural_candidates={meta['structural_candidate_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
