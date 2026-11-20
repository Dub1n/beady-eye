#!/usr/bin/env python3
"""Summarize a retained observe-work-pane capture without live queries.

Usage: python3 tools/work_trial_summary.py PRIVATE_CAPTURE_DIRECTORY
The JSON output contains aggregates only, not captured text or identities.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 128
LIVE_PRESENCE = frozenset({"live_idle", "live_busy"})


def read_json(path: Path):
    with path.open("rb") as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"{path.name} exceeds the input limit")
    return json.loads(data)


def summarize(directory: Path):
    report = read_json(directory / "report.json")
    manifest = read_json(directory / "manifest.json")
    with (directory / "observations.jsonl").open("rb") as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("observation stream exceeds the input limit")
    lines = data.splitlines()
    if len(lines) > MAX_RECORDS:
        raise ValueError("observation stream exceeds the record limit")
    events = [json.loads(line) for line in lines]
    samples = []
    previous_tree = previous_target = previous_visible = None
    previous_target_available = False
    known_visible = False
    for event in events:
        if event["kind"] != "checkpoint":
            continue
        state = event["state"]
        tree, target = state["tree"], state["target"]
        visible = event.get("visible")
        visible_hash = event.get("visibleSha256")
        inherited = (visible is None and known_visible and visible_hash is not None
                     and visible_hash == previous_visible)
        if visible is not None:
            known_visible = True
        elif not inherited:
            known_visible = False
        nodes = tree["nodes"]
        statuses = Counter(node.get("status", "unknown") for node in nodes)
        executions = Counter(node.get("execution", "unknown") for node in nodes)
        worker_states = {}
        unidentified = 0
        coordinator_only = 0
        for node in nodes:
            activity = node.get("activity") or {}
            workers = activity.get("workers") or []
            if (
                node.get("agent_live") is True
                and node.get("execution") != "active"
                and activity.get("coordinator_presence") in LIVE_PRESENCE
                and (node.get("agent") or {}).get("source") in (None, "native_coordinator")
                and not any(worker.get("worker_presence") in LIVE_PRESENCE
                            for worker in (activity, *workers))
            ):
                coordinator_only += 1
            for worker in workers:
                identity = worker.get("task_id")
                if not identity:
                    unidentified += 1
                    continue
                key = (worker.get("project"), identity)
                worker_states.setdefault(key, set()).add(worker.get("worker_presence", "unknown"))
        confirmed = sum(states in ({"live_idle"}, {"live_busy"},
                                   {"live_idle", "live_busy"})
                        for states in worker_states.values())
        unknown = sum(states == {"unknown"} for states in worker_states.values())
        other = len(worker_states) - confirmed - unknown
        evidence = Counter(item for node in nodes
                           for item in (node.get("activity") or {}).get("evidence", [])
                           if item in {"dispatch metadata missing", "native task record missing",
                                       "collection task-read limit (256) exceeded",
                                       "no current dispatch receipt"})
        incoming = Counter((link["to"]["project"], link["to"]["id"])
                           for link in tree["links"])
        tree_hash = hashlib.sha256(json.dumps(tree, sort_keys=True).encode()).hexdigest()
        target_hash = hashlib.sha256(json.dumps(target, sort_keys=True).encode()).hexdigest()
        complete = bool(known_visible and event.get("paneSampledAt") and event.get("treeSampledAt")
                        and event.get("beadFactsSampledAt") and not event.get("metadataReadError"))
        samples.append({
            "at": event.get("at"),
            "sample": "paired" if complete else "partial",
            "pane_recorded": visible is not None,
            "pane_inherited_unchanged": inherited,
            "pane_available": known_visible,
            "visible_changed": None if previous_visible is None else visible_hash != previous_visible,
            "tree_changed": None if previous_tree is None else tree_hash != previous_tree,
            "target_changed": (target_hash != previous_target
                               if previous_target is not None and previous_target_available
                               and target.get("available") is True else None),
            "target_metadata_available": target.get("available"),
            "metadata_read_error": event.get("metadataReadError") is not None,
            "target_occurrences": tree.get("targetOccurrences"),
            "target_paths": len(tree["paths"]),
            "nodes": len(nodes),
            "links": len(tree["links"]),
            "nodes_with_multiple_incoming_links": sum(count > 1 for count in incoming.values()),
            "statuses": dict(statuses),
            "execution_evidence": dict(executions),
            "coordinator_only_live_hints": coordinator_only,
            "activity_evidence": dict(evidence),
            "worker_tasks": {"confirmed_presence": confirmed, "unknown": unknown,
                             "other_or_conflicting": other,
                             "unidentified_associations": unidentified},
        })
        previous_tree, previous_target, previous_visible = tree_hash, target_hash, visible_hash
        previous_target_available = target.get("available") is True
    return {
        "capture_seconds": manifest.get("seconds"),
        "stop_reason": report.get("stopReason"),
        "stop_error": report.get("error"),
        "non_atomic": report.get("atomic") is False,
        "record_count_matches": report.get("records") == len(events),
        "samples": samples,
        "limitations": report.get("limitations", []),
        "worker_count_basis": "distinct project and task_id in activity.workers; presence is not association proof",
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        result = summarize(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, RecursionError) as error:
        print(f"work trial summary: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
