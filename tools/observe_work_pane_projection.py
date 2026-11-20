"""Project bdi documents onto one requested bead subtree."""

from __future__ import annotations

import json
from typing import TypeAlias

Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]
MAX_NODES = 4096
MAX_LINKS = 8192
MAX_OFF_FOCUS_WORKERS = 4096
CLOCK_FIELDS = frozenset({"generated_at", "observed_at", "read_at", "speaks_until"})


class ProjectionError(ValueError):
    """The bounded bdi document cannot be scoped without ambiguity."""


def normalized(value: Json) -> Json:
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items() if key not in CLOCK_FIELDS}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value


def key_of(row: dict[str, Json]) -> tuple[str, str]:
    project, bead = row.get("project"), row.get("id")
    if not isinstance(project, str) or not isinstance(bead, str):
        raise ProjectionError("bdi JSON contained a node without project and bead identity")
    return project, bead


def scoped_snapshot(value: Json, project: str, bead: str) -> dict[str, Json]:
    if not isinstance(value, dict) or not isinstance(value.get("trees"), list):
        raise ProjectionError("bdi JSON did not contain trees")
    facts: dict[tuple[str, str], dict[str, Json]] = {}
    fact_bytes: dict[tuple[str, str], bytes] = {}
    links: dict[tuple[tuple[str, str], tuple[str, str], str], dict[str, Json]] = {}
    paths: set[tuple[tuple[str, str], ...]] = set()
    roots: set[tuple[str, str]] = set()
    occurrences = 0
    for tree in value["trees"]:
        if not isinstance(tree, dict) or not isinstance(tree.get("nodes"), list):
            continue
        rows = tree["nodes"]
        parents: list[int | None] = []
        stack: list[tuple[int, int]] = []
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or type(row.get("depth")) is not int:
                raise ProjectionError("bdi JSON contained a malformed tree row")
            depth = row["depth"]
            while stack and stack[-1][0] >= depth:
                stack.pop()
            parents.append(stack[-1][1] if stack else None)
            stack.append((depth, index))
        selected = [
            index for index, row in enumerate(rows)
            if isinstance(row, dict) and row.get("project") == project and row.get("id") == bead
        ]
        if not selected:
            continue
        if tree.get("project") != project:
            raise ProjectionError("selected bead appeared under another project")
        root = tree.get("root")
        if not isinstance(root, str):
            raise ProjectionError("bdi JSON tree omitted its root identity")
        roots.add((project, root))
        for at in selected:
            occurrences += 1
            path_indices: list[int] = []
            cursor: int | None = at
            while cursor is not None:
                path_indices.append(cursor)
                cursor = parents[cursor]
            paths.add(tuple(key_of(rows[index]) for index in reversed(path_indices)))
            depth = rows[at]["depth"]
            end = at + 1
            while end < len(rows) and rows[end]["depth"] > depth:
                end += 1
            for index in range(at, end):
                row = rows[index]
                identity = key_of(row)
                facts_row = {name: item for name, item in row.items() if name not in {"depth", "edge"}}
                encoded = json.dumps(facts_row, sort_keys=True, separators=(",", ":")).encode()
                if identity in fact_bytes and fact_bytes[identity] != encoded:
                    raise ProjectionError("duplicate bead identity had conflicting facts")
                fact_bytes[identity] = encoded
                facts[identity] = facts_row
                parent_index = parents[index]
                edge = row.get("edge")
                if parent_index is not None:
                    parent = key_of(rows[parent_index])
                    edge_name = edge if isinstance(edge, str) else ""
                    link_key = (parent, identity, edge_name)
                    links[link_key] = {
                        "from": {"project": parent[0], "id": parent[1]},
                        "to": {"project": identity[0], "id": identity[1]},
                        "type": edge,
                    }
                if len(facts) > MAX_NODES or len(links) > MAX_LINKS:
                    raise ProjectionError("selected subtree exceeded its node or link limit")
    if not occurrences:
        raise ProjectionError("bdi JSON had no node for the exact project and bead")
    projected: dict[str, Json] = {
        "project": project,
        "bead": bead,
        "roots": [{"project": p, "id": r} for p, r in sorted(roots)],
        "paths": [[{"project": p, "id": i} for p, i in path] for path in sorted(paths)],
        "nodes": list(facts.values()),
        "links": list(links.values()),
        "targetOccurrences": occurrences,
    }
    if "off_focus_workers" in value:
        candidates = value["off_focus_workers"]
        if not isinstance(candidates, list) or len(candidates) > MAX_OFF_FOCUS_WORKERS:
            raise ProjectionError("off-focus work exceeded its record limit or was malformed")
        ids = {
            row["id"] for row in candidates
            if isinstance(row, dict) and row.get("project") == project
            and isinstance(row.get("id"), str) and row["id"]
            and row.get("role") == "delegated_worker" and row.get("execution") == "active"
        }
        projected["off_focus_workers"] = [
            {"project": project, "id": bead_id, "role": "delegated_worker", "execution": "active"}
            for bead_id in sorted(ids)
        ]
    return projected


def target_metadata(value: Json, project: str, bead: str) -> dict[str, Json]:
    if not isinstance(value, dict):
        raise ProjectionError("bdi --beads --brief returned a non-object")
    entries: list[Json] = []
    for section in ("beads", "ready", "ready_gates", "delivered", "in_delivery", "waiting"):
        rows = value.get(section)
        if isinstance(rows, list):
            entries.extend(rows)
    matches = [
        row for row in entries
        if isinstance(row, dict) and row.get("project") == project and row.get("id") == bead
    ]
    if not matches:
        return {"available": False, "reason": "target_not_in_unfinished_bead_projection"}

    def facts(row: dict[str, Json]) -> dict[str, Json]:
        metadata = row.get("metadata")
        return {
            "available": True,
            "project": project,
            "bead": bead,
            "status": row.get("status"),
            "metadata": metadata if isinstance(metadata, dict) else {},
        }

    result = facts(matches[0])
    if any(facts(row) != result for row in matches[1:]):
        raise ProjectionError("target metadata projection returned conflicting duplicate rows")
    return result
