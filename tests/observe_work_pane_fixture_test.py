"""Isolated viewer fixture for recorder integration; no real tracker or Herdr."""

import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
BDI = ROOT / "bin" / "bdi"
SHIMS = ROOT / "tests" / "shims"
BEAD = "ark-fixture"
TITLE = "Invented orchard maintenance"
ROW = {
    "id": BEAD,
    "title": TITLE,
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "metadata": {"stage": "harvest"},
    "dependencies": [],
}


class ViewerFixture:
    """Own a private environment, tracker answers, and viewer configuration."""

    def __init__(self, root):
        self.root = root
        self.project = root / "orchard"
        self.project.mkdir()
        answers = root / "answers"
        answers.mkdir()
        for command in (
            "list --all --include-gates --limit 0 --json",
            "list --all --include-gates --brief --limit 0 --json",
            "list --include-gates --limit 0 --json",
            f"show {BEAD} --json",
        ):
            (answers / command).write_text(json.dumps([ROW]))
        for command in (
            "query ephemeral=true --all --limit 0 --json",
            "ready --brief --limit 0 --json",
            "ready --type gate --brief --limit 0 --json",
            "blocked --json",
        ):
            (answers / command).write_text("[]")
        self.config = root / "config.toml"
        self.config.write_text(
            f'[[projects]]\nname = "orchard"\npath = "{self.project}"\n'
        )
        self.env = {
            "HOME": str(root),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_RUNTIME_DIR": str(root),
            "PATH": f"{SHIMS}:/usr/bin:/bin",
            "TERM": "xterm-256color",
            "BDI_SHIM_BD_ANSWERS": str(answers),
        }

    def argv(self):
        return [
            str(BDI), "--config", str(self.config), "--project", "orchard",
            "--no-poll", "--socket", str(self.root / "viewer.sock"), "--all",
            f"orchard:{BEAD}",
        ]


class ViewerFixtureTests(unittest.TestCase):
    def test_invented_tracker_reaches_structured_view(self):
        with tempfile.TemporaryDirectory(prefix="recorder-fixture-") as directory:
            fixture = ViewerFixture(Path(directory))
            result = subprocess.run(
                fixture.argv() + ["--json"],
                cwd=fixture.project, env=fixture.env,
                capture_output=True, text=True, timeout=15, check=True,
            )
            payload = json.loads(result.stdout)
            self.assertEqual(len(payload["trees"]), 1)
            tree = payload["trees"][0]
            self.assertEqual((tree["project"], tree["root"]), ("orchard", BEAD))
            self.assertEqual(len(tree["nodes"]), 1)
            node = tree["nodes"][0]
            self.assertEqual(
                (node["project"], node["id"], node["title"], node["status"]),
                ("orchard", BEAD, TITLE, "in_progress"),
            )
            self.assertEqual(node["execution"], "unknown")
            self.assertIsNone(node["agent"])

    def test_invented_tracker_draws_in_real_pty(self):
        with tempfile.TemporaryDirectory(prefix="recorder-fixture-") as directory:
            fixture = ViewerFixture(Path(directory))
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 120, 0, 0))
            seen = threading.Event()
            output = bytearray()

            def drain():
                while select.select([master], [], [], 15)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        return
                    if not chunk:
                        return
                    output.extend(chunk)
                    if TITLE.encode() in output:
                        seen.set()

            def own_terminal():
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

            try:
                with subprocess.Popen(
                    fixture.argv(), cwd=fixture.project, env=fixture.env,
                    stdin=slave, stdout=slave, stderr=slave, preexec_fn=own_terminal,
                ) as child:
                    os.close(slave)
                    slave = -1
                    reader = threading.Thread(target=drain, daemon=True)
                    reader.start()
                    try:
                        self.assertTrue(seen.wait(15), bytes(output).decode(errors="replace"))
                        self.assertIn(b"\x1b[?1049h", output)
                    finally:
                        os.killpg(child.pid, signal.SIGTERM)
                        child.wait(timeout=5)
                        reader.join(timeout=5)
            finally:
                os.close(master)
                if slave != -1:
                    os.close(slave)


if __name__ == "__main__":
    unittest.main()
