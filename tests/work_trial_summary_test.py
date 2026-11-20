"""Offline summary tests using invented capture data."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "work_trial_summary", Path(__file__).parents[1] / "tools/work_trial_summary.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def write_capture(directory, events, stop="window_complete"):
    (directory / "manifest.json").write_text(json.dumps({"seconds": 30}))
    (directory / "report.json").write_text(json.dumps({
        "records": len(events), "stopReason": stop, "atomic": False,
    }))
    (directory / "observations.jsonl").write_text(
        "".join(json.dumps(event) + "\n" for event in events)
    )


def checkpoint(tree, target, screen, fingerprint="screen", error=None):
    return {
        "kind": "checkpoint", "paneSampledAt": "t1", "treeSampledAt": "t2",
        "beadFactsSampledAt": None if error else "t3", "metadataReadError": error,
        "visible": screen, "visibleSha256": fingerprint,
        "state": {"tree": tree, "target": target},
    }


class TrialSummaryTests(unittest.TestCase):
    def test_partial_metadata_does_not_imply_tree_or_pane_change(self):
        tree = {"nodes": [{"status": "in_progress", "execution": "unknown"}],
                "links": [], "paths": [[], []], "targetOccurrences": 2}
        events = [checkpoint(tree, {"available": True}, "invented pane"),
                  checkpoint(tree, {"available": False}, None, error="deadline")]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_capture(path, events, "target_metadata_read_failed")
            result = module.summarize(path)

        first, last = result["samples"]
        assert first["sample"] == "paired"
        assert last["sample"] == "partial"
        assert last["pane_inherited_unchanged"]
        assert last["visible_changed"] is False
        assert last["tree_changed"] is False
        assert last["target_changed"] is None
        assert last["target_metadata_available"] is False
        assert last["target_paths"] == 2
        assert last["statuses"] == {"in_progress": 1}
        assert last["execution_evidence"] == {"unknown": 1}
        assert result["stop_reason"] == "target_metadata_read_failed"

    def test_worker_presence_is_independent_of_activity_state(self):
        workers = [
            {"project": "demo", "task_id": "a", "state": "Working"},
            {"project": "demo", "task_id": "b", "state": "Unknown",
             "worker_presence": "live_busy"},
            {"project": "demo", "task_id": "b", "worker_presence": "live_busy"},
            {"project": "demo", "task_id": "c", "worker_presence": "live_idle"},
            {"project": "demo", "task_id": "c", "worker_presence": "unknown"},
            {"project": "demo"},
        ]
        tree = {"nodes": [{"activity": {"workers": workers}}],
                "links": [], "paths": [[]], "targetOccurrences": 1}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_capture(path, [checkpoint(tree, {"available": True}, "screen")])
            result = module.summarize(path)

        assert result["samples"][0]["worker_tasks"] == {
            "confirmed_presence": 1, "unknown": 1, "other_or_conflicting": 1,
            "unidentified_associations": 1,
        }

    def test_unresolved_pane_reference_is_not_paired_even_with_timestamps(self):
        tree = {"nodes": [], "links": [], "paths": [], "targetOccurrences": 1}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_capture(path, [checkpoint(tree, {"available": True}, None)])
            result = module.summarize(path)
        self.assertEqual(result["samples"][0]["sample"], "partial")
        self.assertFalse(result["samples"][0]["pane_available"])

    def test_live_owner_and_verified_execution_are_counted_separately(self):
        nodes = [
            {"status": "closed", "agent_live": True, "execution": "unknown",
             "activity": {"coordinator_presence": "live_idle"}},
            {"status": "in_progress", "agent_live": True, "execution": "active",
             "activity": {"coordinator_presence": "live_idle",
                          "worker_presence": "live_busy"}},
            {"agent_live": True, "execution": "unknown", "agent": {"source": "display_agent"}},
        ]
        tree = {"nodes": nodes, "links": [], "paths": [[]], "targetOccurrences": 1}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_capture(path, [checkpoint(tree, {"available": True}, "screen")])
            sample = module.summarize(path)["samples"][0]
        self.assertEqual(sample["coordinator_only_live_hints"], 1)
        self.assertEqual(sample["execution_evidence"], {"unknown": 2, "active": 1})

    def test_rejects_oversized_observation_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            write_capture(path, [])
            (path / "observations.jsonl").write_bytes(b"x" * (module.MAX_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "observation stream exceeds"):
                module.summarize(path)
