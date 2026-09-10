#!/usr/bin/env python3
"""Generate the mapper's MCP catalogue and compact analytical snapshot.

Both outputs come from a sibling checkout of cross-border-stablecoin-register.
The generator fails on unmapped/duplicate MCP tools, incomplete corridors, or
register-version/date drift.  That makes updating the Register checkout ref and
all mapper snapshots one atomic review operation.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


MCP_LAYERS = {
    "node": (
        "about", "list_jurisdictions", "list_dimensions", "get_record", "query",
        "compare_dimension", "jurisdiction_profile", "search", "coverage", "records",
    ),
    "evidence": (
        "citable_law", "verification_report", "verification_worklist", "verification_ledger",
    ),
    "constraint": (
        "interaction_sets", "architectural_patterns", "open_questions",
        "constraint_substrate", "compatibility",
    ),
    "corridor": (
        "get_corridor", "compose_corridor", "corridor_directed", "explain_feasibility",
        "compose_via_substrate", "edge_coverage", "corridor_skeleton",
    ),
    "time": ("event_calendar", "events_by_kind", "corridor_timeline", "forward_view"),
    "computed": ("reconciliation", "convergence"),
    "stakeholder": ("stakeholder_database", "profile_for"),
    "agentic": (
        "search_evidence", "get_rule", "evaluate_action", "compare_jurisdictions",
        "watch_changes", "audit_decision",
    ),
}


def load(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"REGISTER INPUT MISSING: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def build_mcp(register_dir: Path) -> dict:
    manifest = load(register_dir / "mcp.json")
    tools = manifest.get("tools") or []
    by_name = {}
    for tool in tools:
        name = tool.get("name")
        if not name:
            raise SystemExit("MCP CONTRACT: every mcp.json tool needs a name")
        if name in by_name:
            raise SystemExit(f"MCP CONTRACT: duplicate tool {name}")
        by_name[name] = tool

    mapped = [name for names in MCP_LAYERS.values() for name in names]
    missing = sorted(set(by_name) - set(mapped))
    stale = sorted(set(mapped) - set(by_name))
    if missing or stale:
        raise SystemExit(
            "MCP LAYER DRIFT — update MCP_LAYERS deliberately:\n"
            f"  unmapped manifest tools: {missing}\n  mappings absent from manifest: {stale}"
        )

    layers = {}
    for layer, names in MCP_LAYERS.items():
        layers[layer] = [
            {
                "n": name,
                "s": by_name[name].get("summary") or "",
                "signature": by_name[name].get("signature") or "",
                "module": by_name[name].get("module") or "",
            }
            for name in names
        ]

    return {
        "schema": "cbsr/mapper-mcp-snapshot/v1",
        "version": manifest.get("version"),
        "count": len(tools),
        "guardrails": manifest.get("guardrails") or [],
        "layers": layers,
    }


def _compact_corridors(computed: dict, jurisdiction_count: int) -> dict:
    edges = computed.get("edges") or []
    expected = jurisdiction_count * (jurisdiction_count - 1)
    if len(edges) != expected:
        raise SystemExit(f"COMPUTE COVERAGE: expected {expected} directed edges, found {len(edges)}")

    seen_edges = set()
    corridors = {}
    contingent = {}
    for edge in sorted(edges, key=lambda item: (item.get("compatibility_pair", ""), item["origin"], item["destination"])):
        direction = f"{edge['origin']}->{edge['destination']}"
        if direction in seen_edges:
            raise SystemExit(f"COMPUTE COVERAGE: duplicate edge {direction}")
        seen_edges.add(direction)
        pair = edge.get("compatibility_pair") or "-".join(sorted((edge["origin"], edge["destination"])))
        entry = corridors.setdefault(pair, {"d": {}, "u": edge.get("compatibility_category")})
        if entry["u"] != edge.get("compatibility_category"):
            raise SystemExit(f"COMPUTE CONTRACT: pair category disagrees within {pair}")
        entry["d"][direction] = {
            "c": edge.get("class_code"),
            "o": bool(edge.get("origin_override")),
        }

        timeline = edge.get("as_of_timeline") or {}
        today = timeline.get("today_class") or edge.get("class_code")
        for transition in timeline.get("scheduled") or []:
            entry.setdefault("t", []).append({
                "dt": transition.get("effective_date"),
                "e": direction,
                "f": today,
                "to": transition.get("resolves_to"),
                "kind": "scheduled_with_cap"
                if transition.get("date_kind") == "outer_cap"
                else transition.get("status"),
                "dk": transition.get("date_kind"),
                "eid": transition.get("event_id"),
            })
        for transition in timeline.get("contingent") or []:
            key = (pair, transition.get("event_id"))
            contingent.setdefault(key, []).append({
                "e": direction,
                "f": today,
                "to": transition.get("resolves_to"),
            })

    for (pair, trigger), moves in contingent.items():
        corridors[pair].setdefault("w", []).append({"trig": trigger, "mv": moves})
    for entry in corridors.values():
        entry["d"] = dict(sorted(entry["d"].items()))
        if "t" in entry:
            entry["t"].sort(key=lambda item: (item.get("dt") or "", item["e"]))
        if "w" in entry:
            entry["w"].sort(key=lambda item: item.get("trig") or "")
    return dict(sorted(corridors.items()))


def _compact_forward(source: dict) -> dict:
    output = {}
    jurisdictions = source.get("jurisdictions") or {}
    items = jurisdictions.values() if isinstance(jurisdictions, dict) else jurisdictions
    for item in items:
        code = item.get("jurisdiction")
        output[code] = {
            "events": item.get("own_pending_events") or [],
            "summary": item.get("summary") or {},
            "inbound": item.get("inbound_reclassified") or [],
            "outbound": item.get("outbound_reclassified") or [],
            "exposure": item.get("counterpart_exposure") or [],
            "reading": item.get("supervisor_reading") or "",
        }
    return output


def build_compute(register_dir: Path) -> dict:
    dataset = load(register_dir / "dataset.json")
    analysis = register_dir / "analysis"
    directed = load(analysis / "computed_corridors_directed.json")
    forward = load(analysis / "computed_forward_view.json")
    sensitivity = load(analysis / "computed_sensitivity.json")
    compatibility = load(analysis / "computed_compatibility.json")
    settlement = load(analysis / "computed_settlement.json")
    convergence = load(analysis / "computed_convergence.json")
    calendar = load(analysis / "event_calendar.json")

    version = dataset.get("version")
    generated = dataset.get("generated")
    if directed.get("register_version") != version:
        raise SystemExit(
            "COMPUTE VERSION DRIFT: computed_corridors_directed.register_version "
            f"is {directed.get('register_version')}, dataset is {version}"
        )
    if directed.get("generated") != generated:
        raise SystemExit(
            "COMPUTE BUILD DRIFT: computed corridor generated date "
            f"is {directed.get('generated')}, dataset is {generated}"
        )

    jurisdiction_count = len({record.get("jurisdiction") for record in dataset.get("records") or []})
    corridors = _compact_corridors(directed, jurisdiction_count)
    class_counts = Counter(
        cell["c"] for pair in corridors.values() for cell in pair.get("d", {}).values()
    )
    declared_counts = (directed.get("coverage") or {}).get("class_distribution") or {}
    if dict(class_counts) != declared_counts:
        raise SystemExit(
            f"COMPUTE CLASS DRIFT: derived {dict(class_counts)}, declared {declared_counts}"
        )

    sensitivity_view = {
        "finding": sensitivity.get("finding"),
        "ordering": sensitivity.get("ordering") or [],
        "insensitive": sensitivity.get("insensitive") or [],
        "two_orderings": sensitivity.get("two_orderings") or {},
        "disagreement": sensitivity.get("disagreement_as_finding") or {},
        "ranking_criteria": sensitivity.get("ranking_criteria"),
    }
    undirected = compatibility.get("undirected_pairs") or {}
    reconciliation = {
        "pairs": undirected.get("pairs") or [],
        "agreement": undirected.get("agreement"),
        "findings_by_cause": compatibility.get("findings_by_cause") or {},
        "note": compatibility.get("method") or "",
    }
    settlement_view = {
        "claim_class": settlement.get("claim_class"),
        "evidence_tier": settlement.get("evidence_tier"),
        "correction": settlement.get("correction"),
        "experiments": settlement.get("experiments") or [],
        "bloc": settlement.get("bloc_membership") or {},
        "counts": settlement.get("counts") or {},
        "finding": settlement.get("finding"),
    }
    convergence_view = {
        key: convergence.get(key)
        for key in ("finding", "discipline", "anchor", "sibling", "counter_example")
    }
    origin_override_edges = sum(
        1 for edge in directed.get("edges") or []
        if edge.get("origin_override")
    )
    artifact = {
        "schema": "cbsr/mapper-compute-snapshot/v1",
        "register_version": version,
        "generated": generated,
        "as_of": forward.get("as_of_base"),
        "corridor_artifact_revision": directed.get("artifact_revision"),
        "corridor_artifact_revision_date": directed.get("artifact_revision_date"),
        "directed_corridors": len(directed.get("edges") or []),
        "class_distribution": declared_counts,
        "reconciliation_agreement": undirected.get("agreement"),
        "origin_override_edges": origin_override_edges,
        "source_versions": {
            "forward": forward.get("version"),
            "sensitivity": sensitivity.get("version"),
            "settlement": settlement.get("version"),
            "convergence": convergence.get("version"),
            "events": calendar.get("version"),
        },
    }
    return {
        "corridors": corridors,
        "forward": _compact_forward(forward),
        "sensitivity": sensitivity_view,
        "reconciliation": reconciliation,
        "settlement": settlement_view,
        "events": calendar.get("events") or [],
        "convergence": convergence_view,
        "_artifact": artifact,
    }


def render(name: str, value: dict, source: str) -> str:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return (
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n"
        f"// Source: cross-border-stablecoin-register/{source}\n"
        "// Regenerate/check with tools/build_mapper_derived.py.\n"
        f"export const {name} = {body};\n"
        f"export default {name};\n"
    )


def write_or_check(path: Path, rendered: str, check: bool) -> bool:
    if check:
        if not path.exists() or path.read_text(encoding="utf-8") != rendered:
            print(f"DERIVED SNAPSHOT DRIFT: {path}", file=sys.stderr)
            return False
        print(f"snapshot OK: {path}")
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered, encoding="utf-8")
    print(f"wrote {path}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--register", required=True, type=Path)
    parser.add_argument("--mcp-out", required=True, type=Path)
    parser.add_argument("--compute-out", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    mcp = build_mcp(args.register)
    compute = build_compute(args.register)
    ok_mcp = write_or_check(args.mcp_out, render("MCP", mcp, "mcp.json"), args.check)
    ok_compute = write_or_check(
        args.compute_out,
        render("COMPUTE", compute, "analysis/computed_*.json"),
        args.check,
    )
    return 0 if ok_mcp and ok_compute else 3


if __name__ == "__main__":
    raise SystemExit(main())
