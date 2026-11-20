# noqa: SIZE_OK - the assignment permits one driver integration test file.
"""Public CLI tests using only invented private evidence."""
import datetime as dt
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "tools/work_sweep.py"
PIN = "a" * 64
sys.path.insert(0, str(SCRIPT.parent))
import work_sweep as driver


class Clock:
    def __init__(self):
        self.value = 0.0

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class SweepDriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / "state"
        self.evidence = self.root / "evidence"
        self.frames = self.root / "observer"
        for directory in (self.state, self.evidence, self.frames):
            directory.mkdir(mode=0o700)
        self.manifest = {
            "schemaVersion": 1, "project": "orchard", "bead": "orc-1",
            "pane": "wfixture:p1", "pid": 123, "tty": "/dev/pts/123",
            "cwd": "/invented/project",
            "bdi_sha256": PIN, "config_sha256": "b" * 64,
        }
        self.report = {
            "schemaVersion": 1, "project": "orchard", "bead": "orc-1",
            "pane": "wfixture:p1", "viewerPid": 123, "tty": "/dev/pts/123",
            "bdiSha256": PIN, "configSha256": "b" * 64,
            "stopReason": "target_metadata_read_failed", "records": 5,
        }
        self.write(self.evidence / "manifest.json", self.manifest)
        self.write(self.evidence / "report.json", self.report)

    def write(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def call(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], text=True,
                              capture_output=True, check=False,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def register(self):
        return self.call("register-startup", "--state-dir", str(self.state),
                         "--manifest", str(self.evidence / "manifest.json"),
                         "--expected-sha256", PIN)

    def mapped_inputs(self, control, observer=None):
        gates = []
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")):
            record = self.evidence / f"record-{index}.json"
            bead = f"orc-{index + 10}"
            self.write(record, {"id": bead, "status": "open"})
            gates.append({"phase": phase, "bead": bead, "record": str(record),
                          "receiptRoot": str(self.evidence)})
        scope = {"project": "orchard", "projectRoot": "/invented/project",
                 "taskDirectory": "/invented/tasks", "rootSession": "root-a"}
        config = {"version": 1, **scope, "manifest": str(self.evidence / "manifest.json"),
                  "gates": gates, "controlRecord": str(control)}
        if observer is not None:
            config["observerDirectory"] = str(observer)
        mapping = self.evidence / "mapping.json"
        self.write(mapping, config)
        return mapping, scope

    def test_registers_existing_startup_once_and_replays_it(self):
        first = self.register()
        second = self.register()
        replay = self.call("replay", "--state-dir", str(self.state))

        self.assertEqual((first.returncode, second.returncode, replay.returncode), (0, 0, 0))
        result = json.loads(replay.stdout)
        self.assertEqual(result["slots"], {"1": {"phase": "G0", "status": "existing_startup",
                                                  "trigger": "startup"}})
        self.assertEqual(result["startup"]["stopReason"], "target_metadata_read_failed")
        self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
        self.assertFalse(result["liveAvailable"])
        self.assertEqual(stat_mode(self.state / "state.json"), 0o600)
        self.assertEqual(sorted(path.name for path in self.state.iterdir()), ["lock", "state.json"])

    def test_mismatched_report_never_creates_state(self):
        self.report["viewerPid"] = 456
        self.write(self.evidence / "report.json", self.report)

        result = self.register()

        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.state / "state.json").exists())

    def test_live_run_refuses_without_touching_inputs(self):
        result = self.call("run")

        self.assertEqual(result.returncode, 2)
        self.assertIn("required", result.stderr)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_run_ticks_mapped_gate_and_resume_does_not_repeat_capture(self):
        gates = []
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")):
            record = self.evidence / f"gate-{index}.json"
            bead = f"orc-{index + 10}"
            self.write(record, {"id": bead, "status": "open", "metadata": {}})
            gates.append({"phase": phase, "bead": bead, "record": str(record),
                          "receiptRoot": str(self.evidence)})
        mapping = {"version": 1, "project": "orchard", "projectRoot": "/invented/project",
                   "taskDirectory": "/invented/tasks", "rootSession": "root-a",
                   "manifest": str(self.evidence / "manifest.json"), "gates": gates}
        mapping_path = self.evidence / "mapping.json"
        self.write(mapping_path, mapping)
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping_path),
                "--expected-sha256", PIN, "--duration", "301"]
        calls = []
        clock = Clock()

        def capture(manifest, target, output, *, expected_sha256):
            state = json.loads((self.state / "state.json").read_text())
            self.assertEqual(state["slots"]["2"]["status"], "reserved")
            calls.append((target, output.name, expected_sha256))
            return SimpleNamespace(status="complete")

        with patch.object(driver, "time", clock), patch.object(driver, "capture_once", capture), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(driver.main(), 0)
        self.assertEqual(calls, [("orchard:orc-10", "capture-002.json", PIN)])

        persisted = json.loads((self.state / "state.json").read_text())
        persisted["cursor"]["nextTick"] = 0
        self.write(self.state / "state.json", persisted)
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("reissued")), \
             patch.object(sys, "argv", ["work_sweep.py", *args[:-1], "1"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(driver.main(), 0)
        replay = self.call("replay", "--state-dir", str(self.state))
        state = json.loads(replay.stdout)
        self.assertEqual(state["slots"]["1"]["status"], "existing_startup")
        self.assertEqual(state["slots"]["2"]["status"], "complete")
        self.assertEqual(set(state["slots"]), {"1", "2"})
        self.assertEqual(state["cursor"]["nextTick"], 600)
        self.assertLessEqual(len(state["scheduler"]["events"]), 3)
        state["slots"]["2"]["status"] = "reserved"
        self.write(self.state / "state.json", state)
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("reissued")), \
             patch.object(sys, "argv", ["work_sweep.py", *args[:-1], "1"]), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(driver.main(), 2)
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("reissued")), \
             patch.object(sys, "argv", ["work_sweep.py", *args[:-1], "1", "--confirm-stopped"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(driver.main(), 0)
        recovered = json.loads((self.state / "state.json").read_text())
        self.assertEqual(recovered["slots"]["2"]["status"], "missed_interrupted")

    def test_legacy_ledger_refusal_does_not_mutate_existing_state(self):
        control = self.evidence / "control.json"
        mapping, _ = self.mapped_inputs(control)
        self.assertEqual(self.register().returncode, 0)
        state_path = self.state / "state.json"
        state = json.loads(state_path.read_text())
        state["scheduler"]["events"].extend([
            {"id": "close-G0", "kind": "disposition", "at": 1, "phase": "G0",
             "unit": None, "disposition": "accepted", "qualified": False},
            {"id": "block-G1", "kind": "disposition", "at": 2, "phase": "G1",
             "unit": None, "disposition": "external_blocker", "qualified": False},
            {"id": "legacy-clock", "kind": "advance", "at": 302, "phase": None,
             "unit": None, "disposition": None, "qualified": False},
        ])
        state["cursor"] = {"elapsed": 302, "nextTick": 902, "paused": False}
        state["running"] = True
        state["clockRecovery"] = "retained-value"
        state["slots"]["3"] = {
            "phase": "G1", "trigger": "disposition:external_blocker",
            "at": 2, "target": "orchard:orc-11", "status": "reserved",
        }
        state["interrupted"] = False
        self.write(state_path, state)
        original = state_path.read_bytes()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "1", "--confirm-stopped"]

        with patch.object(driver, "capture_once", side_effect=AssertionError("invalid ledger captured")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(driver.main(), 2)

        self.assertEqual(state_path.read_bytes(), original)

    def test_historical_accepted_gate_is_missed_not_captured(self):
        receipt = self.evidence / "receipt.json"
        receipt.write_bytes(b'{"result":"invented"}')
        receipt.chmod(0o600)
        gates = []
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")):
            bead = f"orc-{index + 10}"
            record = self.evidence / f"gate-{index}.json"
            issue = {"id": bead, "status": "open", "metadata": {}}
            if index == 0:
                issue["status"] = "closed"
                issue["metadata"] = {"qrclipWork": {"accepted": {
                    "passed": True, "receipt": {"path": receipt.name,
                        "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()}}}}
            self.write(record, issue)
            gates.append({"phase": phase, "bead": bead, "record": str(record),
                          "receiptRoot": str(self.evidence)})
        mapping_path = self.evidence / "mapping.json"
        self.write(mapping_path, {"version": 1, "project": "orchard",
                   "projectRoot": "/invented/project", "taskDirectory": "/invented/tasks",
                   "rootSession": "root-a", "manifest": str(self.evidence / "manifest.json"),
                   "gates": gates})
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping_path),
                "--expected-sha256", PIN, "--duration", "1"]
        output = io.StringIO()

        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("stale capture")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertEqual(result["slots"]["2"]["status"], "missed_historical")
        self.assertEqual(result["slots"]["2"]["phase"], "G0")

    def test_new_receipt_backed_gate_capture_uses_its_mapped_bead(self):
        control = self.evidence / "control.json"
        mapping, _ = self.mapped_inputs(control)
        receipt = self.evidence / "receipt.json"
        self.write(receipt, {"result": "invented"})
        digest = hashlib.sha256(receipt.read_bytes()).hexdigest()
        record = self.evidence / "record-0.json"

        class ControlledClock(Clock):
            def sleep(inner, seconds):
                super().sleep(seconds)
                if inner.value == 1:
                    self.write(record, {"id": "orc-10", "status": "closed",
                               "metadata": {"qrclipWork": {"accepted": {"passed": True,
                               "receipt": {"path": receipt.name, "sha256": digest}}}}})

        clock, calls, output = ControlledClock(), [], io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "2"]
        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1]) or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertEqual(calls, ["orchard:orc-10"])
        self.assertEqual(result["slots"]["2"]["trigger"], "disposition:accepted")

    def test_durable_park_and_resume_pause_active_timer(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"transition": "recorded"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}
        signals = []
        self.write(control, {"version": 1, **scope, "events": signals})

        class ControlledClock(Clock):
            def sleep(inner, seconds):
                super().sleep(seconds)
                if inner.value in (1, 31):
                    kind = "park" if inner.value == 1 else "resume"
                    signals.append({"id": kind, "kind": kind, "evidence": pointer})
                    self.write(control, {"version": 1, **scope, "events": signals})

        clock = ControlledClock()
        calls = []
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "332"]
        output = io.StringIO()
        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1]) or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertEqual(calls, ["orchard:orc-10"])
        self.assertEqual(result["slots"]["2"]["at"], 330)
        self.assertFalse(result["cursor"]["paused"])

    def test_blocked_gate_stays_current_through_resume_and_later_receipt(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        config = json.loads(mapping.read_text())
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"transition": "recorded"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}

        receipt0 = self.evidence / "receipt-g0.json"
        self.write(receipt0, {"accepted": "invented G0"})
        self.write(Path(config["gates"][0]["record"]), {
            "id": "orc-10", "status": "closed", "metadata": {"qrclipWork": {
                "accepted": {"passed": True, "receipt": {
                    "path": receipt0.name,
                    "sha256": hashlib.sha256(receipt0.read_bytes()).hexdigest(),
                }},
            }},
        })
        signals = []
        self.write(control, {"version": 1, **scope, "events": signals})

        class ControlledClock(Clock):
            def sleep(inner, seconds):
                super().sleep(seconds)
                if inner.value == 1:
                    signals.extend([
                        {"id": "block-g1", "kind": "disposition", "phase": "G1",
                         "disposition": "external_blocker", "evidence": pointer},
                        {"id": "park", "kind": "park", "evidence": pointer},
                    ])
                    self.write(control, {"version": 1, **scope, "events": signals})
                if inner.value == 3:
                    signals.append({"id": "resume", "kind": "resume", "evidence": pointer})
                    self.write(control, {"version": 1, **scope, "events": signals})
                if inner.value == 4:
                    receipt1 = self.evidence / "receipt-g1.json"
                    self.write(receipt1, {"accepted": "invented G1"})
                    self.write(Path(config["gates"][1]["record"]), {
                        "id": "orc-11", "status": "closed", "metadata": {"qrclipWork": {
                            "accepted": {"passed": True, "receipt": {
                                "path": receipt1.name,
                                "sha256": hashlib.sha256(receipt1.read_bytes()).hexdigest(),
                            }},
                        }},
                    })

        clock, calls, output = ControlledClock(), [], io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "5"]

        def capture(manifest, target, output_path, *, expected_sha256):
            state = json.loads((self.state / "state.json").read_text())
            self.assertEqual(state["slots"]["3"]["status"], "reserved")
            calls.append((target, output_path.name, expected_sha256))
            return SimpleNamespace(status="complete")

        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once", capture), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        replayed = driver.SweepScheduler.from_json(json.dumps(result["scheduler"]))
        self.assertEqual(replayed.phase, "G2")
        self.assertEqual(calls, [("orchard:orc-11", "capture-003.json", PIN)])
        self.assertEqual(
            [entry["trigger"] for entry in result["slots"].values()
             if entry["phase"] == "G1" and entry["trigger"].startswith("disposition:")],
            ["disposition:external_blocker"],
        )
        self.assertEqual(result["slots"]["3"]["status"], "complete")
        self.assertFalse(result["cursor"]["paused"])

    def test_historical_external_blocker_keeps_its_slot_without_recapture(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        config = json.loads(mapping.read_text())
        receipt = self.evidence / "receipt-g0.json"
        self.write(receipt, {"accepted": "invented G0"})
        self.write(Path(config["gates"][0]["record"]), {
            "id": "orc-10", "status": "closed", "metadata": {"qrclipWork": {
                "accepted": {"passed": True, "receipt": {
                    "path": receipt.name,
                    "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
                }},
            }},
        })
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"transition": "recorded"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}
        self.write(control, {"version": 1, **scope, "events": [{
            "id": "block-g1", "kind": "disposition", "phase": "G1",
            "disposition": "external_blocker", "evidence": pointer,
        }]})
        class AdvancingClock(Clock):
            def sleep(inner, seconds):
                super().sleep(300)

        clock = AdvancingClock()
        output = io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "600"]

        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once",
                          side_effect=AssertionError("historical blocker recaptured")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        replayed = driver.SweepScheduler.from_json(json.dumps(result["scheduler"]))
        self.assertEqual(replayed.phase, "G1")
        self.assertEqual(set(result["slots"]), {"1", "2", "3"})
        self.assertEqual(result["slots"]["3"]["trigger"], "disposition:external_blocker")
        self.assertEqual(result["slots"]["3"]["status"], "missed_historical")
        self.assertFalse(any(event.kind is driver.EventKind.ADVANCE for event in replayed.events))

    def test_accepted_control_cannot_replace_missing_gate_receipt(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"claim": "accepted"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}
        self.write(control, {"version": 1, **scope, "events": [
            {"id": "claim", "kind": "disposition", "phase": "G0",
             "disposition": "accepted", "evidence": pointer}]})
        output = io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "1"]

        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("false acceptance")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertEqual(list(result["slots"]), ["1"])
        self.assertIn("control_acceptance_receipt_unverified", result["gaps"])

    def test_final_disposition_exits_without_waiting_or_recapture(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"transition": "recorded"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}
        signals = [{"id": phase, "kind": "disposition", "phase": phase,
                    "disposition": "retired", "evidence": pointer}
                   for phase in ("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")]
        self.write(control, {"version": 1, **scope, "events": signals})
        clock, output = Clock(), io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "300"]

        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once", side_effect=AssertionError("historical capture")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertTrue(result["final"])
        self.assertEqual(clock.value, 0)
        self.assertEqual(result["slots"]["8"]["status"], "missed_historical")
        result["slots"]["8"]["status"] = "reserved"
        result["running"] = True
        self.write(self.state / "state.json", result)
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("reissued")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(driver.main(), 2)
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once", side_effect=AssertionError("reissued")), \
             patch.object(sys, "argv", ["work_sweep.py", *args, "--confirm-stopped"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(driver.main(), 0)
        recovered = json.loads((self.state / "state.json").read_text())
        self.assertEqual(recovered["slots"]["8"]["status"], "missed_interrupted")

    def test_scoped_handoff_targets_the_admitted_unit(self):
        control = self.evidence / "control.json"
        mapping, scope = self.mapped_inputs(control)
        proof = self.evidence / "owner-record.json"
        self.write(proof, {"transition": "recorded"})
        pointer = {"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}
        events = []
        self.write(control, {"version": 1, **scope, "events": events})
        now = dt.datetime.now(dt.timezone.utc)
        first = {"version": 1, "scope": {"project": "orchard",
                                          "taskDirectory": "/invented/tasks"},
                 "epoch": "epoch-a", "sequence": 1, "observedAt": now.isoformat(),
                 "expiresAt": (now + dt.timedelta(seconds=3)).isoformat(),
                 "admissions": [], "workers": []}
        second = {**first, "sequence": 2, "admissions": [
            {"task": "task-a", "parent": "root-a", "created": "created",
             "bead": "orc-55", "attempt": "attempt-a", "toolCall": "call-a", "invalid": False}
        ]}

        class ControlledClock(Clock):
            def sleep(inner, seconds):
                super().sleep(seconds)
                if inner.value == 2:
                    events.append({"id": "gate", "kind": "disposition", "phase": "G0",
                                   "disposition": "retired", "evidence": pointer})
                if inner.value == 3:
                    events.append({"id": "handoff", "kind": "handoff", "unit": "orc-55",
                                   "evidence": pointer})
                self.write(control, {"version": 1, **scope, "events": events})

        clock, calls, output = ControlledClock(), [], io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "4"]
        with patch.object(driver, "time", clock), \
             patch.object(driver, "frame_snapshot",
                          side_effect=lambda _: ([first] if clock.value < 1 else [second], [])), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1]) or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        self.assertEqual(calls, ["orchard:orc-55", "orchard:orc-10", "orchard:orc-55"])
        self.assertEqual(result["slots"]["4"]["trigger"], "handoff")

    def test_observer_inspection_uses_producer_frame_filename_and_reports_gap(self):
        now = dt.datetime.now(dt.timezone.utc)
        frame = {"version": 1, "scope": {"project": "orchard",
                                         "taskDirectory": "/invented/tasks"},
                 "epoch": "epoch-a", "sequence": 1, "observedAt": now.isoformat(),
                 "expiresAt": (now + dt.timedelta(seconds=3)).isoformat(),
                 "admissions": [], "workers": []}
        self.write(self.frames / "frame-123-epoch-a.json", frame)

        result = self.call("inspect-observer", "--observer-dir", str(self.frames),
                           "--project", "orchard", "--task-directory", "/invented/tasks",
                           "--project-root", "/invented/project", "--root-session", "root-a")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["eventCounts"], {})
        self.assertIn("observer_frame_has_no_project_root_identity",
                      json.loads(result.stdout)["gaps"])

    def test_sweep_captures_new_root_admission_after_frame_gap_with_exact_provenance(self):
        control = self.evidence / "control.json"
        mapping, _ = self.mapped_inputs(control, self.frames)
        now = dt.datetime.now(dt.timezone.utc)
        frame = {"version": 1, "scope": {"project": "orchard",
                                         "taskDirectory": "/invented/tasks"},
                 "epoch": "epoch-a", "sequence": 1, "observedAt": now.isoformat(),
                 "expiresAt": (now + dt.timedelta(minutes=5)).isoformat(),
                 "admissions": [], "workers": []}
        self.write(self.frames / "frame-123-epoch-a.json", frame)
        scoped = {"project": "orchard", "taskDirectory": "/invented/tasks"}
        root_rows = [
            {"task": f"task-{index}", "parent": "root-a", "created": f"created-{index}",
             "bead": f"ORCH-{index}", "attempt": f"attempt-{index}",
             "toolCall": f"call-{index}", "invalid": False}
            for index in range(7)
        ]
        unrelated_rows = [
            {"task": f"task-other-{index}", "parent": "other-root",
             "created": f"created-other-{index}", "bead": f"OTHER-{index}",
             "attempt": f"attempt-other-{index}", "toolCall": f"call-other-{index}",
             "invalid": False}
            for index in range(5)
        ]

        def save_cache(parent, rows):
            key = json.dumps([scoped, parent], separators=(",", ":"),
                             ensure_ascii=False).encode()
            name = "admission-" + hashlib.sha256(key).hexdigest() + ".json"
            self.write(self.frames / name, {"version": 1, "scope": scoped,
                                            "parent": parent, "admissions": rows})

        class ControlledClock(Clock):
            def sleep(inner, seconds):
                super().sleep(seconds)
                if inner.value == 1:
                    frame["sequence"] = 3
                    self.write(self.frames / "frame-123-epoch-a.json", frame)
                    save_cache("root-a", root_rows)
                    save_cache("other-root", unrelated_rows)

        clock, calls, output = ControlledClock(), [], io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "2"]
        with patch.object(driver, "time", clock), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1])
                          or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        evidence = result["slots"]["2"]["evidence"]
        self.assertIn("missed_frame_sequence", evidence["sweepEvidenceGaps"])
        self.assertEqual(calls, ["orchard:ORCH-0"])
        self.assertEqual(result["slots"]["2"]["trigger"], "admission")
        self.assertEqual((evidence["task"], evidence["parent"], evidence["created"],
                          evidence["bead"], evidence["attempt"], evidence["toolCall"]),
                         ("task-0", "root-a", "created-0", "ORCH-0",
                          "attempt-0", "call-0"))
        self.assertEqual(evidence["evidence"], "durable-admission-cache")
        self.assertNotIn("execution", evidence)
        self.assertEqual(len(result["admissionSeen"]), 7)

    def test_suppressed_admissions_do_not_defer_the_accepted_timer(self):
        control = self.evidence / "control.json"
        mapping, _ = self.mapped_inputs(control)
        receipt = self.evidence / "gate-receipt.json"
        self.write(receipt, {"result": "invented"})
        self.write(self.evidence / "record-0.json", {
            "id": "orc-10", "status": "closed", "metadata": {"qrclipWork": {
                "accepted": {"passed": True, "receipt": {
                    "path": receipt.name,
                    "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
                }},
            }},
        })
        rows = [
            {"task": f"task-{index}", "parent": "root-a", "created": f"created-{index}",
             "bead": f"ORCH-{index}", "attempt": f"attempt-{index}",
             "toolCall": f"call-{index}", "invalid": False}
            for index in range(3)
        ]

        class JumpClock(Clock):
            def sleep(inner, seconds):
                inner.value += 50

        clock, calls, output = JumpClock(), [], io.StringIO()

        def caches(directory, project, task_directory):
            available = sum(clock.value >= threshold for threshold in (150, 200, 250))
            if not available:
                return [], []
            return ([{"version": 1,
                      "scope": {"project": project, "taskDirectory": task_directory},
                      "parent": "root-a", "admissions": rows[:available]}], [])

        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "450"]
        with patch.object(driver, "time", clock), \
             patch.object(driver, "admission_snapshot", side_effect=caches), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1])
                          or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        triggers = [slot["trigger"] for _, slot in sorted(
            result["slots"].items(), key=lambda item: int(item[0])
        )]
        self.assertEqual(triggers, [
            "startup", "disposition:accepted", "admission", "timer",
        ])
        self.assertEqual(calls, ["orchard:ORCH-0", "orchard:orc-11"])
        self.assertEqual(result["slots"]["4"]["at"], 450)

    def test_nested_capture_keeps_both_lead_and_leaf_worker_identities(self):
        control = self.evidence / "control.json"
        mapping, _ = self.mapped_inputs(control, self.frames)
        now = dt.datetime.now(dt.timezone.utc)
        stamp = now.isoformat()
        expires = (now + dt.timedelta(minutes=5)).isoformat()

        def task(task_id, bead, attempt, parent, child, identity):
            return (
                {"task": task_id, "parent": parent, "created": f"created-{task_id}",
                 "bead": bead, "attempt": attempt, "toolCall": f"call-{task_id}",
                 "invalid": False},
                {"task": task_id, "parent": parent, "created": f"created-{task_id}",
                 "child": child, "session": child, "identity": identity,
                 "source": "invented-current-source", "execution": "active",
                 "invalid": False, "observedAt": stamp},
            )

        lead_a = task("task-lead-a", "ORCH-1", "attempt-lead-a",
                      "root-a", "lead-a", "instance-lead-a")
        lead_b = task("task-lead-b", "ORCH-2", "attempt-lead-b",
                      "root-a", "lead-b", "instance-lead-b")
        leaf_a = task("task-leaf-a", "ORCH-3", "attempt-leaf-a",
                      "lead-a", "leaf-a", "instance-leaf-a")
        leaf_b = task("task-leaf-b", "ORCH-4", "attempt-leaf-b",
                      "lead-b", "leaf-b", "instance-leaf-b")

        def frame(epoch, sequence, rows=()):
            return {"version": 1, "scope": {"project": "orchard",
                                             "taskDirectory": "/invented/tasks"},
                    "epoch": epoch, "sequence": sequence, "observedAt": stamp,
                    "expiresAt": expires,
                    "admissions": [row for row, _ in rows],
                    "workers": [worker for _, worker in rows]}

        for filename, value in (
            ("frame-root.json", frame("root-producer", 1, (lead_a, lead_b))),
            ("frame-root-current.json", frame("root-producer", 2, (lead_a, lead_b))),
            ("frame-lead-a.json", frame("lead-a-producer", 1, (leaf_a,))),
            ("frame-lead-b.json", frame("lead-b-producer", 1, (leaf_b,))),
        ):
            self.write(self.frames / filename, value)

        calls, output = [], io.StringIO()
        args = ["run", "--state-dir", str(self.state), "--mapping", str(mapping),
                "--expected-sha256", PIN, "--duration", "1"]
        with patch.object(driver, "time", Clock()), \
             patch.object(driver, "capture_once",
                          side_effect=lambda *a, **k: calls.append(a[1])
                          or SimpleNamespace(status="complete")), \
             patch.object(sys, "argv", ["work_sweep.py", *args]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(driver.main(), 0)

        result = json.loads(output.getvalue())
        evidence = result["slots"]["2"]["evidence"]
        self.assertEqual(calls, ["orchard:ORCH-3"])
        self.assertEqual(evidence["evidence"],
                         "two-distinct-admitted-active-leads-and-leaves")
        self.assertEqual(
            {(worker["task"], worker["identity"], worker["bead"], worker["attempt"])
             for worker in evidence["leadWorkers"]},
            {("task-lead-a", "instance-lead-a", "ORCH-1", "attempt-lead-a"),
             ("task-lead-b", "instance-lead-b", "ORCH-2", "attempt-lead-b")},
        )
        self.assertEqual(
            {(worker["task"], worker["identity"], worker["bead"], worker["attempt"])
             for worker in evidence["leaves"]},
            {("task-leaf-a", "instance-leaf-a", "ORCH-3", "attempt-leaf-a"),
             ("task-leaf-b", "instance-leaf-b", "ORCH-4", "attempt-leaf-b")},
        )

    def test_consecutive_frames_preserve_distinct_lead_overlap_and_admissions(self):
        previous = self.root / "previous"
        previous.mkdir(mode=0o700)
        now = dt.datetime.now(dt.timezone.utc)
        stamp = now.isoformat()
        frame = {"version": 1, "scope": {"project": "orchard",
                                         "taskDirectory": "/invented/tasks"},
                 "epoch": "epoch-a", "sequence": 1, "observedAt": stamp,
                 "expiresAt": (now + dt.timedelta(seconds=3)).isoformat(),
                 "admissions": [], "workers": []}
        self.write(previous / "frame-123-epoch-a.json", frame)
        pairs = [("lead-a", "root-a", "session-a", "orc-10"),
                 ("leaf-a", "session-a", "child-a", "orc-11"),
                 ("lead-b", "root-a", "session-b", "orc-20"),
                 ("leaf-b", "session-b", "child-b", "orc-21")]
        frame["sequence"] = 2
        frame["admissions"] = [
            {"task": task, "parent": parent, "created": "created",
             "bead": bead, "attempt": "attempt", "toolCall": "call", "invalid": False}
            for task, parent, child, bead in pairs
        ]
        frame["workers"] = [
            {"task": task, "parent": parent, "created": "created", "child": child,
             "session": child, "identity": child, "source": "fixture",
             "execution": "active", "observedAt": stamp}
            for task, parent, child, bead in pairs
        ]
        self.write(self.frames / "frame-123-epoch-a.json", frame)

        result = self.call("inspect-observer", "--previous-observer-dir", str(previous),
                           "--observer-dir", str(self.frames), "--project", "orchard",
                           "--task-directory", "/invented/tasks",
                           "--project-root", "/invented/project", "--root-session", "root-a")

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["eventCounts"], {"first_admission_observed": 4,
                                                   "nested_overlap": 1})
        self.assertIn("observer_frame_has_no_project_root_identity", payload["gaps"])

    def test_replay_rejects_symlinked_state(self):
        (self.state / "state.json").symlink_to(self.evidence / "manifest.json")

        result = self.call("replay", "--state-dir", str(self.state))

        self.assertEqual(result.returncode, 2)


def stat_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
