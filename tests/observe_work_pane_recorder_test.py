"""Exercise the current-pane recorder with a real PTY and read-only adapter."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socketserver
import struct
import subprocess
import tempfile
import termios
import threading
import unittest

from observe_work_pane_fixture_test import BDI, BEAD, ROOT, ROW, TITLE, ViewerFixture

ENTRY = ROOT / "tools" / "observe-work-pane.py"
ADAPTER = ROOT / "tests" / "recorder_herdr_adapter.py"
PANE = "wfixture:p1"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class PrivateHerdr:
    """Expose only process-info and visible reads for the test's own PTY."""

    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.reads = 0
        self.viewer = None
        self.output = bytearray()
        self.changed = threading.Condition()
        self.started = threading.Event()
        self.read_ready = threading.Event()
        self.output_dir = fixture.root / "evidence"
        self.output_dir.mkdir(mode=0o700)
        self.socket = fixture.root / "herdr.sock"
        fake_bin = fixture.root / "fake-bin"
        fake_bin.mkdir()
        fake_herdr = fake_bin / "herdr"
        fake_herdr.write_bytes(ADAPTER.read_bytes())
        fake_herdr.chmod(0o700)
        fixture.env.update({
            "PATH": f'{fake_bin}:{fixture.env["PATH"]}',
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": PANE,
            "HERDR_WORKSPACE_ID": "wfixture",
            "RECORDER_FIXTURE_SOCKET": str(self.socket),
        })
        owner = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                args = json.loads(self.rfile.readline())
                try:
                    reply = {"status": 0, "stdout": owner.dispatch(args), "stderr": ""}
                except (OSError, ValueError, AssertionError) as error:
                    reply = {"status": 1, "stdout": "", "stderr": str(error)}
                self.wfile.write(json.dumps(reply).encode() + b"\n")

        self.server = socketserver.ThreadingUnixStreamServer(str(self.socket), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def drain(self):
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            with self.changed:
                self.output.extend(data)
                self.changed.notify_all()

    def dispatch(self, args):
        self.calls.append(args)
        assert self.started.wait(10), "launcher never started"
        if args == ["pane", "process-info", "--pane", PANE]:
            proc = Path(f"/proc/{self.viewer.pid}")
            argv = proc.joinpath("cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            process = {
                "pid": self.viewer.pid,
                "argv": [arg.decode() for arg in argv],
                "cwd": os.readlink(proc / "cwd"),
            }
            return json.dumps({"result": {"process_info": {
                "pane_id": PANE, "foreground_processes": [process],
            }}})
        if args == ["pane", "read", PANE, "--source", "visible", "--lines", "200",
                    "--format", "text", "--raw"]:
            with self.changed:
                ready = self.changed.wait_for(
                    lambda: TITLE.encode() in self.output
                    and "qquit" in ANSI.sub("", self.output.decode(errors="replace")),
                    timeout=2,
                )
                assert ready, "real PTY did not show the viewer footer"
                if self.reads == 0:
                    # Ratatui positions the footer's cells separately; the
                    # adapter approximates their visible-space reconstruction.
                    self.visible = ANSI.sub("", self.output.decode(errors="replace")).replace(
                        "qquit", "\nq quit\n"
                    )
            self.reads += 1
            self.read_ready.set()
            if self.reads == 4:
                rows = json.loads(
                    (self.fixture.root / "answers" /
                     "list --all --include-gates --limit 0 --json").read_text()
                )
                changed = [dict(row, status="blocked") if row["id"] == BEAD else row
                           for row in rows]
                for name in (
                    "list --all --include-gates --limit 0 --json",
                    "list --all --include-gates --brief --limit 0 --json",
                    "list --include-gates --limit 0 --json",
                    f"show {BEAD} --json",
                ):
                    value = [row for row in changed if row["id"] == BEAD] if name.startswith("show ") else changed
                    (self.fixture.root / "answers" / name).write_text(json.dumps(value))
            return self.visible + ("\n[invented view changed]\n" if self.reads >= 4 else "")
        raise ValueError(f"refused unrelated Herdr request: {args}")

    def launch(self, argv):
        self.master, slave = pty.openpty()
        tty = os.ttyname(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 120, 0, 0))

        def own_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        try:
            self.viewer = subprocess.Popen(
                argv, cwd=self.fixture.project, env=self.fixture.env,
                stdin=slave, stdout=slave, stderr=slave, preexec_fn=own_terminal,
            )
        finally:
            os.close(slave)
        self.started.set()
        self.reader = threading.Thread(target=self.drain, daemon=True)
        self.reader.start()
        return tty

    def close(self):
        if self.viewer is not None and self.viewer.poll() is None:
            os.killpg(self.viewer.pid, signal.SIGTERM)
            self.viewer.wait(timeout=5)
        if hasattr(self, "master"):
            os.close(self.master)
            self.reader.join(timeout=5)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class RecorderCliTests(unittest.TestCase):
    def command(self, fixture, herdr, seconds="5", digest=None):
        sha = digest or hashlib.sha256(BDI.read_bytes()).hexdigest()
        return [
            "/usr/bin/python3", str(ENTRY), "--bdi", str(BDI), "--sha256", sha,
            "--project", "orchard", "--bead", BEAD, "--config", str(fixture.config),
            "--output-dir", str(herdr.output_dir), "--seconds", seconds, "--interval", "1",
        ]

    def test_current_pane_records_changes_and_suppresses_unchanged_samples(self):
        with tempfile.TemporaryDirectory(prefix="recorder-e2e-") as directory:
            fixture = ViewerFixture(Path(directory))
            def parent(bead, children):
                return dict(ROW, id=bead, title=bead, dependencies=[
                    {"depends_on_id": child, "type": "blocks"} for child in children
                ])
            rows = [
                parent("ark-root", ["ark-left", "ark-right"]),
                parent("ark-left", [BEAD]),
                parent("ark-right", [BEAD]),
                ROW,
            ]
            for name in (
                "list --all --include-gates --limit 0 --json",
                "list --all --include-gates --brief --limit 0 --json",
                "list --include-gates --limit 0 --json",
            ):
                (fixture.root / "answers" / name).write_text(json.dumps(rows))
            herdr = PrivateHerdr(fixture)
            try:
                tty = herdr.launch(self.command(fixture, herdr))
                self.assertTrue(herdr.read_ready.wait(12), "helper did not read the viewer")
                children = Path(f"/proc/{herdr.viewer.pid}/task/{herdr.viewer.pid}/children").read_text()
                helper = int(children.split()[0])
                with os.fdopen(os.pidfd_open(helper), "rb") as helper_fd:
                    self.assertTrue(select.select([helper_fd], [], [], 12)[0], "helper did not exit")
                runs = list(herdr.output_dir.iterdir())
                self.assertEqual(len(runs), 1)
                events = [json.loads(line) for line in (runs[0] / "observations.jsonl").read_text().splitlines()]
                report = json.loads((runs[0] / "report.json").read_text())
                checkpoints = [event for event in events if event["kind"] == "checkpoint"]
                self.assertEqual(len(checkpoints), 2, report)
                self.assertGreaterEqual(herdr.reads, 4)
                self.assertEqual(
                    [item["state"]["tree"]["nodes"][0]["status"] for item in checkpoints],
                    ["in_progress", "blocked"],
                )
                self.assertEqual(
                    [item["state"]["target"]["status"] for item in checkpoints],
                    ["in_progress", "blocked"],
                )
                for item in checkpoints:
                    self.assertEqual((item["pane"], item["pid"], item["tty"]),
                                     (PANE, herdr.viewer.pid, tty))
                    self.assertEqual(item["state"]["tree"]["bead"], BEAD)
                    self.assertEqual(item["state"]["tree"]["targetOccurrences"], 2)
                    self.assertEqual(item["state"]["tree"]["roots"],
                                     [{"project": "orchard", "id": "ark-root"}])
                    self.assertEqual(len(item["state"]["tree"]["paths"]), 2)
                    self.assertEqual([node["id"] for node in item["state"]["tree"]["nodes"]],
                                     [BEAD])
                    self.assertEqual(item["state"]["target"]["metadata"], {"stage": "harvest"})
                    self.assertEqual((item["state"]["target"]["project"],
                                      item["state"]["target"]["bead"]), ("orchard", BEAD))
                    self.assertEqual(set(item["reasons"]),
                                     {"scoped_bdi_state_changed", "visible_view_changed"})
                    self.assertIn(TITLE, item["visible"])
                    self.assertFalse(item["atomic"])
                self.assertEqual((report["pane"], report["viewerPid"], report["tty"]),
                                 (PANE, herdr.viewer.pid, tty))
                self.assertEqual(report["stopReason"], "window_complete")
                self.assertLessEqual(report["records"], 128)
                self.assertLessEqual(report["bytes"], 16 * 1024 * 1024)
                self.assertIsNone(herdr.viewer.poll(), "capture must leave the viewer running")
                self.assertFalse(any(call[:2] in (["pane", "split"], ["pane", "run"])
                                     for call in herdr.calls))
                self.assertEqual(runs[0].stat().st_mode & 0o777, 0o700)
                for name in ("manifest.json", "observations.jsonl", "report.json"):
                    self.assertEqual((runs[0] / name).stat().st_mode & 0o777, 0o600)
            finally:
                herdr.close()

    def test_refuses_wrong_pin_and_out_of_bounds_window_before_launch(self):
        with tempfile.TemporaryDirectory(prefix="recorder-refusal-") as directory:
            fixture = ViewerFixture(Path(directory))
            herdr = PrivateHerdr(fixture)
            try:
                for command in (
                    self.command(fixture, herdr, digest="0" * 64),
                    self.command(fixture, herdr, seconds="121"),
                ):
                    result = subprocess.run(
                        command, cwd=fixture.project, env=fixture.env,
                        capture_output=True, text=True, timeout=15,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(herdr.calls, [])
                    self.assertEqual(list(herdr.output_dir.iterdir()), [])
            finally:
                herdr.close()


if __name__ == "__main__":
    unittest.main()
