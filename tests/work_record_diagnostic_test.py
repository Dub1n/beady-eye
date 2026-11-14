import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "work-record-diagnostic.py"
SPEC = importlib.util.spec_from_file_location("work_record_diagnostic", SCRIPT)
DIAG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAG)
PROJECT = "invented-project"


def issue(status="in_progress", mode="delegate", dispatch=None):
    metadata = {"qrclipWork": {"attempt": {
        "id": "attempt-new", "mode": mode, "coordinator": "owner-invented"}}}
    if dispatch is not None:
        metadata["qrclipDispatch"] = dispatch
    return {"id": "inv-1", "status": status, "description": "PRIVATE PROMPT",
            "metadata": metadata}


def receipt(**changes):
    return dict({"attemptId": "attempt-new", "taskId": "task_fixture"}, **changes)


def native(**changes):
    return dict({"task_id": "task_fixture", "parent_session_id": "owner-invented",
                 "child_session_id": "child-invented", "status": "completed",
                 "spawn_spec": {"prompt": "PRIVATE PROMPT", "cwd": "PRIVATE PATH"}}, **changes)


class WorkRecordDiagnosticTests(unittest.TestCase):
    def row(self, rec, directory=None):
        return DIAG.diagnose([rec], directory, PROJECT)["records"][0]

    def with_native(self, value, rec=None):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "task_fixture.json").write_text(json.dumps(value))
            return self.row(rec or issue(dispatch=receipt()), directory)

    def test_raw_bd_rows_require_external_project(self):
        self.assertEqual(self.row(issue())["project"], PROJECT)
        with self.assertRaises(ValueError):
            DIAG.diagnose([issue()])
        rec = issue()
        rec["project"] = "other-project"
        with self.assertRaises(ValueError):
            self.row(rec)

    def test_lifecycle_missing_receipts_and_direct(self):
        for status, expected in (("in_progress", "missing_receipt"),
                                 ("hooked", "transitional_without_receipt"),
                                 ("blocked", "transitional_without_receipt"),
                                 ("closed", "historical_without_receipt"),
                                 ("open", "inactive_without_receipt")):
            with self.subTest(status=status):
                self.assertEqual(self.row(issue(status=status))["classification"], expected)
        self.assertEqual(self.row(issue(mode="direct"))["classification"], "direct_attempt")
        self.assertTrue(self.row(issue(mode="direct", dispatch=receipt()))["conflict"])

    def test_historical_receipt_is_never_read_as_current(self):
        rec = issue(dispatch={"attemptId": "attempt-old", "taskId": "task_fixture"})
        row = self.with_native(native(), rec)
        self.assertEqual(row["classification"], "historical_receipt")
        self.assertTrue(row["staleReceipt"])
        self.assertEqual(row["nativeRecord"], "not_requested")

    def test_real_native_schema_only_produces_unverified_observation(self):
        row = self.with_native(native())
        self.assertEqual(row["unverifiedTaskRecordChildSession"], "child-invented")
        self.assertEqual(row["classification"], "partial_receipt")
        self.assertNotIn("correlated", json.dumps(row))
        result = DIAG.diagnose([issue()], project=PROJECT)
        self.assertFalse(any(result["claims"].values()))

    def test_reused_task_ids_do_not_prove_bead_or_attempt(self):
        row = self.with_native(native())
        self.assertIn("unverified_task_record_child_observation", row["reasons"])
        for key in ("project", "bead_id", "attempt_id", "task_id", "parent_session_id", "coordinator"):
            with self.subTest(key=key):
                row = self.with_native(native(**{key: "other-invented"}))
                self.assertTrue(row["conflict"])
                self.assertEqual(row["nativeRecord"], "identity_mismatch")
                self.assertIsNone(row["unverifiedTaskRecordChildSession"])

    def test_supplied_child_mismatch_is_conflict(self):
        row = self.with_native(native(), issue(dispatch=receipt(childSession="other-child")))
        self.assertTrue(row["conflict"])

    def test_parent_requires_independently_recorded_attempt_coordinator(self):
        rec = issue(dispatch=receipt())
        del rec["metadata"]["qrclipWork"]["attempt"]["coordinator"]
        row = self.with_native(native(), rec)
        self.assertIsNone(row["unverifiedTaskRecordChildSession"])
        self.assertIn("independent_coordinator_binding_missing", row["reasons"])
        value = native()
        del value["parent_session_id"]
        self.assertIsNone(self.with_native(value)["unverifiedTaskRecordChildSession"])

    def test_missing_invalid_and_ambiguous_fields(self):
        for dispatch in ({}, [], {"attemptId": []}, receipt(childSession=[])):
            self.assertEqual(self.row(issue(dispatch=dispatch))["classification"], "partial_receipt")
        for key in ("task_id", "parent_session_id", "child_session_id", "attempt_id"):
            row = self.with_native(native(**{key: []}))
            self.assertEqual(row["nativeRecord"], "invalid")
            self.assertIsNone(row["unverifiedTaskRecordChildSession"])
        old_schema = {"id": "task_fixture", "session_id": "child-invented"}
        self.assertEqual(self.with_native(old_schema)["nativeRecord"], "invalid")
        rec = issue()
        rec["metadata"]["qrclipWork"]["attempt"] = []
        self.assertEqual(self.row(rec)["classification"], "partial_attempt")

    def test_explicit_null_child_is_absent_and_orphan_receipt_is_partial(self):
        row = self.with_native(native(), issue(dispatch=receipt(childSession=None)))
        self.assertEqual(row["classification"], "partial_receipt")
        self.assertNotIn("invalid_receipt_child_session", row["reasons"])
        self.assertEqual(row["unverifiedTaskRecordChildSession"], "child-invented")
        rec = issue(dispatch=receipt())
        del rec["metadata"]["qrclipWork"]["attempt"]
        self.assertEqual(self.row(rec)["classification"], "partial_receipt")

    def test_multiple_workers_are_audited_independently(self):
        for dispatch in ([receipt(childSession="child-invented"),
                          receipt(taskId="task_second", childSession="child-second")],
                         {"tasks": [receipt(childSession="child-invented"),
                                    receipt(taskId="task_second", childSession="child-second")]}):
            with self.subTest(dispatch=dispatch), tempfile.TemporaryDirectory() as directory:
                Path(directory, "task_fixture.json").write_text(json.dumps(native()))
                Path(directory, "task_second.json").write_text(json.dumps(native(
                    task_id="task_second", child_session_id="child-second")))
                row = self.row(issue(dispatch=dispatch), directory)
                self.assertEqual(row["classification"], "multiple_receipts")
                self.assertFalse(row["ambiguous"])
                self.assertEqual([w["unverifiedTaskRecordChildSession"] for w in row["receipts"]],
                                 ["child-invented", "child-second"])
                self.assertIsNone(row["unverifiedTaskRecordChildSession"])
                self.assertNotIn("PRIVATE", json.dumps(row))

    def test_duplicate_workers_are_ambiguous_without_losing_entries(self):
        row = self.with_native(native(), issue(dispatch=[receipt(), receipt()]))
        self.assertTrue(row["ambiguous"])
        self.assertEqual(len(row["receipts"]), 2)
        for worker in row["receipts"]:
            self.assertIn("duplicate_task_id", worker["reasons"])
            self.assertIsNone(worker["unverifiedTaskRecordChildSession"])

    def test_invalid_or_historical_worker_does_not_hide_valid_sibling(self):
        row = self.with_native(native(), issue(dispatch=[[], receipt()]))
        self.assertTrue(row["ambiguous"])
        self.assertEqual(row["receipts"][0]["nativeRecord"], "not_requested")
        self.assertEqual(row["receipts"][1]["unverifiedTaskRecordChildSession"], "child-invented")
        invalid = self.with_native(native(), issue(dispatch=[receipt(childSession=[]), receipt()]))
        self.assertTrue(invalid["receipts"][0]["ambiguous"])
        self.assertIsNone(invalid["receipts"][0]["unverifiedTaskRecordChildSession"])
        row = self.with_native(native(), issue(dispatch=[
            receipt(attemptId="attempt-old", taskId="task_old"), receipt()]))
        self.assertTrue(row["staleReceipt"])
        self.assertEqual(row["receipts"][0]["classification"], "historical_receipt")
        self.assertEqual(row["receipts"][0]["nativeRecord"], "not_requested")
        self.assertEqual(row["receipts"][1]["nativeRecord"], "observed")

    def test_nested_and_oversize_collections_are_bounded(self):
        for dispatch in ([[receipt()]], {"tasks": {"tasks": [receipt()]}},
                         {"tasks": [receipt()], "taskId": "task_fixture"},
                         [receipt()] * (DIAG.MAX_RECEIPTS + 1)):
            with self.subTest(dispatch=dispatch), patch.object(DIAG, "native_record") as read:
                row = self.row(issue(dispatch=dispatch), "unused-invented-directory")
                self.assertTrue(row["ambiguous"])
                self.assertEqual(row["classification"], "ambiguous_receipts")
                read.assert_not_called()
        with patch.object(DIAG, "MAX_TOTAL_RECEIPTS", 1):
            rows = DIAG.diagnose([issue(dispatch=[receipt()]), issue(dispatch=[receipt()])],
                                 project=PROJECT)["records"]
            self.assertFalse(rows[0]["ambiguous"])
            self.assertIn("receipt_limit_exceeded", rows[1]["reasons"])

    def test_privacy(self):
        text = json.dumps(self.with_native(native()))
        for private in ("PRIVATE", "spawn_spec", "prompt", "cwd", "description"):
            self.assertNotIn(private, text)

    def test_files_are_bounded_and_nofollow(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "task_fixture.json")
            self.assertEqual(self.row(issue(dispatch=receipt()), directory)["nativeRecord"], "unavailable")
            for content in ("[", "[]", "x" * (DIAG.MAX_TASK_BYTES + 1)):
                path.write_text(content)
                self.assertEqual(self.row(issue(dispatch=receipt()), directory)["nativeRecord"], "invalid")
            path.unlink()
            target = Path(directory, "target.json")
            target.write_text(json.dumps(native()))
            path.symlink_to(target)
            self.assertEqual(self.row(issue(dispatch=receipt()), directory)["nativeRecord"], "invalid")
            path.unlink()
            os.mkfifo(path)
            self.assertEqual(self.row(issue(dispatch=receipt()), directory)["nativeRecord"], "invalid")
            self.assertEqual(self.row(issue(dispatch=receipt(taskId="../secret")), directory)["nativeRecord"], "invalid_task_id")

    def test_growth_read_still_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "task_fixture.json").write_text("{}")
            amounts = []
            def growing_read(fd, amount):
                amounts.append(amount)
                return b"x" * amount
            with patch.object(DIAG.os, "read", side_effect=growing_read):
                self.assertEqual(self.row(issue(dispatch=receipt()), directory)["nativeRecord"], "invalid")
            self.assertEqual(sum(amounts), DIAG.MAX_TASK_BYTES + 1)

    def test_input_bounds_and_cli(self):
        for value in ([{}] * (DIAG.MAX_TASKS + 1), [{}], {}, [False]):
            with self.assertRaises(ValueError):
                DIAG.diagnose(value, project=PROJECT)
        result = subprocess.run([sys.executable, str(SCRIPT), "--project", PROJECT],
                                input=json.dumps([issue()]), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, str(SCRIPT), "--project", PROJECT],
                                input=b" " * (DIAG.MAX_STDIN + 1), capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_total_receipt_budget_includes_mixed_scalar_and_collection_forms(self):
        scalar = issue(dispatch=receipt())
        collection = issue(dispatch=[receipt(), receipt(taskId="second_task")])
        with patch.object(DIAG, "MAX_TOTAL_RECEIPTS", 2):
            rows = DIAG.diagnose([scalar, collection], project=PROJECT)["records"]
        self.assertEqual(rows[1]["classification"], "ambiguous_receipts")
        self.assertIn("receipt_limit_exceeded", rows[1]["reasons"])
        self.assertEqual(rows[1]["receipts"], [])


if __name__ == "__main__":
    unittest.main()
