"""The recorder must refuse a mismatched current-pane identity."""

import json
import os
from pathlib import Path
import select
import tempfile
import threading
import unittest

from observe_work_pane_fixture_test import ViewerFixture
import observe_work_pane_recorder_test as harness


class WrongPaneHerdr(harness.PrivateHerdr):
    def __init__(self, fixture):
        self.requested = threading.Event()
        super().__init__(fixture)

    def dispatch(self, args):
        if args[:2] == ["pane", "process-info"]:
            self.calls.append(args)
            self.requested.set()
            return json.dumps({"result": {"process_info": {
                "pane_id": "wfixture:other", "foreground_processes": [],
            }}})
        return super().dispatch(args)


class CurrentPaneIdentityTests(unittest.TestCase):
    def test_wrong_current_pane_identity_refuses_capture(self):
        with tempfile.TemporaryDirectory(prefix="recorder-identity-") as directory:
            fixture = ViewerFixture(Path(directory))
            herdr = WrongPaneHerdr(fixture)
            try:
                herdr.launch(harness.RecorderCliTests().command(fixture, herdr))
                self.assertTrue(herdr.requested.wait(10))
                children = Path(
                    f"/proc/{herdr.viewer.pid}/task/{herdr.viewer.pid}/children"
                ).read_text()
                with os.fdopen(os.pidfd_open(int(children.split()[0])), "rb") as helper:
                    self.assertTrue(select.select([helper], [], [], 10)[0])
                run = next(herdr.output_dir.iterdir())
                report = json.loads((run / "report.json").read_text())
                self.assertEqual(report["stopReason"], "capture_failed")
                self.assertIn("exact invoking pane", report["error"])
                self.assertFalse(any(call[:2] == ["pane", "read"] for call in herdr.calls))
                self.assertIsNone(herdr.viewer.poll())
            finally:
                herdr.close()


if __name__ == "__main__":
    unittest.main()
