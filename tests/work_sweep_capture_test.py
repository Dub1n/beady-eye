"""Isolated tests for one-shot capture of an existing pinned viewer."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import pty
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import work_sweep_capture as capture
from _work_sweep_reader import SweepReader
from observe_work_pane_reader import ReaderError, process_start_ticks

PANE = "wfixture:p1"
TARGET = "ark-closed"


class FixtureReader(SweepReader):
    """Keep the real process identity checks and replace only external reads."""

    instances: list[FixtureReader] = []
    reject_pid = False
    reject_tty = False
    fail_brief = False

    def __init__(self, spec):
        super().__init__(spec)
        self.calls: list[tuple[str, ...]] = []
        type(self).instances.append(self)

    def herdr(self, args, deadline, limit=1024 * 1024):
        self.calls.append(tuple(args))
        if args[:2] == ["pane", "process-info"]:
            pid = int(os.environ["SWEEP_FIXTURE_PID"])
            argv = Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            process = {
                "pid": pid + int(type(self).reject_pid),
                "argv": [part.decode() for part in argv],
                "cwd": os.readlink(f"/proc/{pid}/cwd"),
            }
            return json.dumps({"result": {"process_info": {
                "pane_id": PANE,
                "foreground_processes": [process],
            }}})
        if args[:2] == ["pane", "read"]:
            return "Orchard · invented visible row"
        raise AssertionError(f"unexpected Herdr query: {args}")

    def viewer(self, deadline):
        if type(self).reject_tty:
            self.spec["tty"] = "/dev/pts/99999"
        return super().viewer(deadline)

    def bounded_bdi(self, args, deadline):
        self.calls.append(tuple(args))
        if "--all" in args:
            self.tree_sampled_at = self.stamp()
        elif "--beads" in args:
            self.brief_sampled_at = self.stamp()
        if "--beads" in args and type(self).fail_brief:
            raise ReaderError("capture window ended during bdi read")
        if "--all" in args:
            return json.dumps({"trees": [{
                "project": "orchard",
                "root": "ark-root",
                "nodes": [
                    {"project": "orchard", "id": "ark-root", "depth": 0},
                    {"project": "orchard", "id": TARGET, "depth": 1, "edge": "blocks"},
                ],
            }]}).encode()
        return json.dumps({"beads": []}).encode()


class WorkSweepCaptureTests(unittest.TestCase):
    def setUp(self):
        FixtureReader.instances.clear()
        FixtureReader.reject_pid = False
        FixtureReader.reject_tty = False
        FixtureReader.fail_brief = False
        self.temp = tempfile.TemporaryDirectory(prefix="work-sweep-invented-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.output_dir = self.root / "private"
        self.output_dir.mkdir(mode=0o700)
        self.config = self.root / "config.toml"
        self.config.write_text('[[projects]]\nname = "orchard"\n')
        self.master, slave = pty.openpty()
        self.tty = os.ttyname(slave)
        executable = Path(sys.executable).resolve()
        self.child = subprocess.Popen(
            [
                str(executable), "-c", "import time; time.sleep(30)",
                "--config", str(self.config), "--project", "orchard",
                "--all", "ark-original",
            ],
            cwd=self.root,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        self.addCleanup(self.close)
        proc = Path(f"/proc/{self.child.pid}")
        executable = Path(os.readlink(proc / "exe"))
        self.exe = executable
        self.sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
        self.manifest = self.root / "manifest.json"
        self.output = self.output_dir / "capture.json"
        self.spec = {
            "schemaVersion": 1,
            "started": 1.0,
            "seconds": 120,
            "interval": 5,
            "bdi": str(executable),
            "bdi_sha256": self.sha256,
            "config": str(self.config),
            "config_watch": str(self.config),
            "config_sha256": hashlib.sha256(self.config.read_bytes()).hexdigest(),
            "project": "orchard",
            "bead": "ark-original",
            "cwd": str(self.root),
            "pane": PANE,
            "workspace": "wfixture",
            "pid": self.child.pid,
            "start_ticks": process_start_ticks(self.child.pid),
            "tty": self.tty,
            "tty_dev": os.stat(f"/proc/{self.child.pid}/fd/0").st_dev,
            "tty_rdev": os.stat(f"/proc/{self.child.pid}/fd/0").st_rdev,
            "tty_ino": os.stat(f"/proc/{self.child.pid}/fd/0").st_ino,
            "argv": [
                item.decode()
                for item in Path(f"/proc/{self.child.pid}/cmdline")
                .read_bytes().rstrip(b"\0").split(b"\0")
            ],
        }
        self.manifest.write_text(json.dumps(self.spec))
        self.manifest.chmod(0o600)
        self.report = {
            "schemaVersion": 1,
            "project": "orchard",
            "bead": "ark-original",
            "pane": PANE,
            "viewerPid": self.child.pid,
            "tty": self.tty,
            "bdiSha256": self.sha256,
            "configSha256": self.spec["config_sha256"],
            "stopReason": "target_metadata_read_failed",
        }
        self.manifest.with_name("report.json").write_text(json.dumps(self.report))
        self.manifest.with_name("report.json").chmod(0o600)
        os.environ["SWEEP_FIXTURE_PID"] = str(self.child.pid)
        self.addCleanup(os.environ.pop, "SWEEP_FIXTURE_PID", None)

    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            self.child.wait(timeout=5)
        os.close(self.master)

    def run_capture(self):
        with patch.object(capture, "SweepReader", FixtureReader):
            return capture.capture_once(
                self.manifest,
                f"orchard:{TARGET}",
                self.output,
                expected_sha256=self.sha256,
            )

    def test_captures_nonroot_closed_target_once_without_relaunching(self):
        result = self.run_capture()

        self.assertEqual((result.project, result.bead, result.status),
                         ("orchard", TARGET, "partial"))
        self.assertEqual(result.tree["targetOccurrences"], 1)
        self.assertEqual(result.target["reason"],
                         "target_not_in_unfinished_bead_projection")
        retained = json.loads(self.output.read_text())
        self.assertEqual(retained["viewerTarget"], {
            "project": "orchard", "bead": "ark-original",
        })
        self.assertEqual(retained["queriedTarget"], {
            "project": "orchard", "bead": TARGET,
        })
        self.assertTrue(retained["paneSampledAt"])
        self.assertTrue(retained["treeSampledAt"])
        self.assertTrue(retained["beadFactsSampledAt"])
        reader = FixtureReader.instances[-1]
        self.assertEqual(
            [call[1] for call in reader.calls if call[:2] == ("pane", "read")],
            ["read"],
        )
        queries = [call for call in reader.calls if call and call[0] == str(self.exe)]
        self.assertEqual(len(queries), 2)
        self.assertEqual(sum("--all" in query for query in queries), 1)
        self.assertEqual(sum("--beads" in query for query in queries), 1)
        self.assertTrue(all(query[-1] == TARGET for query in queries))
        self.assertIsNone(self.child.poll())
        self.assertEqual(retained["status"], "partial")

    def test_keeps_tree_when_brief_query_fails(self):
        FixtureReader.fail_brief = True

        result = self.run_capture()

        self.assertEqual(result.status, "partial")
        self.assertEqual(result.tree["targetOccurrences"], 1)
        self.assertEqual(result.error, "capture window ended during bdi read")
        retained = json.loads(self.output.read_text())
        self.assertEqual(retained["status"], "partial")
        self.assertEqual(retained["tree"]["targetOccurrences"], 1)
        self.assertTrue(retained["beadFactsSampledAt"])

    def test_rejects_reused_pid_start_identity(self):
        self.spec["start_ticks"] = "0"
        self.manifest.write_text(json.dumps(self.spec))

        with self.assertRaisesRegex(capture.CaptureError, "PID changed"):
            self.run_capture()

        self.assertFalse(self.output.exists())

    def test_rejects_a_different_foreground_pid(self):
        FixtureReader.reject_pid = True

        with self.assertRaisesRegex(capture.CaptureError, "no longer running"):
            self.run_capture()

        self.assertFalse(self.output.exists())

    def test_rejects_changed_tty_identity(self):
        FixtureReader.reject_tty = True

        with self.assertRaisesRegex(capture.CaptureError, "terminal"):
            self.run_capture()

        self.assertFalse(self.output.exists())

    def test_rejects_wrong_report_pin_before_reading_viewer(self):
        self.report["bdiSha256"] = "0" * 64
        self.manifest.with_name("report.json").write_text(json.dumps(self.report))

        with self.assertRaisesRegex(capture.CaptureError, "trusted expected"):
            self.run_capture()

        self.assertEqual(FixtureReader.instances, [])

    def test_rejects_world_readable_manifest_before_viewer_queries(self):
        self.manifest.chmod(0o644)

        with self.assertRaisesRegex(capture.CaptureError, "unsafe"):
            self.run_capture()

        self.assertEqual(FixtureReader.instances, [])

    def test_rejects_manifest_project_that_disagrees_with_viewer_argv(self):
        self.spec["project"] = "other"
        self.manifest.write_text(json.dumps(self.spec))
        self.report["project"] = "other"
        self.manifest.with_name("report.json").write_text(json.dumps(self.report))

        with self.assertRaisesRegex(capture.CaptureError, "viewer argv"):
            self.run_capture()

        self.assertEqual(FixtureReader.instances, [])

    def test_refuses_existing_output_without_overwriting_it(self):
        self.output.write_text("preserve")

        with self.assertRaisesRegex(capture.CaptureError, "new file"):
            self.run_capture()

        self.assertEqual(self.output.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
