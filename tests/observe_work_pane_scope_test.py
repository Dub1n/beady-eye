"""Scope and bounds of retained recorder state."""

import sys
import unittest

from observe_work_pane_fixture_test import BEAD, ROOT

sys.path.insert(0, str(ROOT / "tools"))
from observe_work_pane_projection import ProjectionError, scoped_snapshot


class ScopedSnapshotTests(unittest.TestCase):
    def test_preserves_only_qualified_off_focus_work_for_the_requested_project(self):
        node = {"project": "orchard", "id": BEAD, "depth": 0, "status": "open"}
        active = {"role": "delegated_worker", "execution": "active"}
        worker = {"project": "orchard", "id": "ark-audit", **active}
        source = {
            "trees": [{"project": "orchard", "root": BEAD, "nodes": [node]}],
            "off_focus_workers": [
                worker,
                worker,
                {"project": "other", "id": "ark-audit", **active},
                {"project": "orchard", "id": "ark-unknown", **active, "execution": "unknown"},
                {"project": "orchard", "id": "ark-owner", **active, "role": "coordinator"},
            ],
        }
        projected = scoped_snapshot(source, "orchard", BEAD)
        self.assertEqual(projected["off_focus_workers"], [worker])
        self.assertEqual([row["id"] for row in projected["nodes"]], [BEAD])

    def test_non_root_duplicates_keep_only_exact_project_subtree(self):
        def row(project, bead, depth, edge=None):
            return {"project": project, "id": bead, "depth": depth, "edge": edge,
                    "status": "open"}

        value = {"trees": [
            {"project": "orchard", "root": "ark-root", "nodes": [
                row("orchard", "ark-root", 0),
                row("orchard", "ark-left", 1, "blocks"),
                row("orchard", BEAD, 2, "blocks"),
                row("orchard", "ark-child", 3, "parent-child"),
                row("orchard", "ark-right", 1, "blocks"),
                row("orchard", BEAD, 2, "blocks"),
                row("orchard", "ark-child", 3, "parent-child"),
                row("orchard", "ark-unrelated", 1, "blocks"),
            ]},
            {"project": "other", "root": BEAD, "nodes": [row("other", BEAD, 0)]},
        ], "unrelated": "do not retain"}
        selected = scoped_snapshot(value, "orchard", BEAD)
        self.assertEqual(selected["targetOccurrences"], 2)
        self.assertEqual({(n["project"], n["id"]) for n in selected["nodes"]},
                         {("orchard", BEAD), ("orchard", "ark-child")})
        self.assertEqual(selected["roots"], [{"project": "orchard", "id": "ark-root"}])
        self.assertEqual(
            [[part["id"] for part in path] for path in selected["paths"]],
            [["ark-root", "ark-left", BEAD], ["ark-root", "ark-right", BEAD]],
        )
        self.assertNotIn("unrelated", selected)
        with self.assertRaises(ProjectionError):
            scoped_snapshot(value, "orchard", "ark-missing")

    def test_subtree_over_node_limit_is_refused(self):
        rows = [
            {"project": "orchard", "id": BEAD, "depth": 0, "edge": None}
        ] + [
            {"project": "orchard", "id": f"ark-{index}", "depth": 1, "edge": "blocks"}
            for index in range(4096)
        ]
        with self.assertRaisesRegex(ProjectionError, "node or link limit"):
            scoped_snapshot({"trees": [{"project": "orchard", "root": BEAD, "nodes": rows}]},
                            "orchard", BEAD)


if __name__ == "__main__":
    unittest.main()
