"""Bounded capture loop and private observation report."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from observe_work_pane_projection import Json, normalized
from observe_work_pane_reader import PinnedReader, ReaderError

MAX_TOTAL = 16 * 1024 * 1024
MAX_RECORDS = 128
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class RecorderError(RuntimeError):
    """A bounded capture or persistence operation failed."""


class Capture:
    """Observe one pinned viewer until its bounded capture window ends."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.spec = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        self.stream = os.open(run_dir / "observations.jsonl", os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
        self.bytes = (run_dir / "observations.jsonl").stat().st_size
        self.records = 0
        self.reader = PinnedReader(self.spec)
        self.stop = "capture_failed"
        self.error: str | None = None

    @staticmethod
    def stamp() -> str:
        return datetime.now(timezone.utc).isoformat()

    def event(self, value: dict[str, Json]) -> None:
        line = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        if self.records >= MAX_RECORDS or self.bytes + len(line) > MAX_TOTAL:
            raise RecorderError("private observation output limit reached")
        start = self.bytes
        try:
            view = memoryview(line)
            while view:
                view = view[os.write(self.stream, view):]
        except OSError:
            os.ftruncate(self.stream, start)
            raise
        self.bytes += len(line)
        self.records += 1

    def run(self) -> int:
        deadline = self.spec["started"] + self.spec["seconds"]
        previous = ""
        previous_screen = ""
        try:
            self.event({"kind": "capture_started", "at": self.stamp(), "atomic": False})
            if not self.reader.ready(deadline):
                self.stop = "viewer_not_ready_before_deadline"
            else:
                self.event({
                    "kind": "viewer_ready", "at": self.stamp(), "pane": self.spec["pane"],
                    "pid": self.spec["pid"], "tty": self.spec["tty"],
                })
                sample_at = time.monotonic()
                while time.monotonic() < deadline:
                    if not self.reader.viewer(deadline):
                        self.stop = "viewer_exited"
                        break
                    pane_at = self.stamp()
                    screen = self.reader.visible(deadline)
                    if not self.reader.viewer(deadline):
                        self.stop = "viewer_exited_during_visible_sample"
                        break
                    tree, metadata, tree_at, metadata_at, metadata_error = (
                        self.reader.target_facts(deadline)
                    )
                    if metadata_error is None and not self.reader.viewer(deadline):
                        self.stop = "viewer_exited_during_bdi_sample"
                        break
                    payload: dict[str, Json] = {"tree": tree, "target": metadata}
                    fingerprint = hashlib.sha256(json.dumps(
                        normalized(payload), sort_keys=True, separators=(",", ":")
                    ).encode()).hexdigest()
                    clean_screen = re.sub(
                        r"\b\d{1,2}:\d{2}(?::\d{2})?\b",
                        "<clock>",
                        ANSI.sub("", screen),
                    )
                    screen_fingerprint = hashlib.sha256(clean_screen.encode()).hexdigest()
                    reasons = []
                    if fingerprint != previous:
                        reasons.append("scoped_bdi_state_changed")
                    if screen_fingerprint != previous_screen:
                        reasons.append("visible_view_changed")
                    if metadata_error is not None:
                        reasons.append("target_metadata_read_failed")
                    if reasons:
                        self.event({
                            "kind": "checkpoint", "at": self.stamp(),
                            "paneSampledAt": pane_at, "treeSampledAt": tree_at,
                            "beadFactsSampledAt": metadata_at,
                            "metadataReadError": metadata_error,
                            "elapsedMs": round((time.monotonic() - self.spec["started"]) * 1000),
                            "project": self.spec["project"], "bead": self.spec["bead"],
                            "pane": self.spec["pane"], "pid": self.spec["pid"], "tty": self.spec["tty"],
                            "reasons": reasons, "stateSha256": fingerprint,
                            "visibleSha256": screen_fingerprint, "state": payload,
                            "visible": screen if screen_fingerprint != previous_screen else None,
                            "atomic": False,
                        })
                        previous, previous_screen = fingerprint, screen_fingerprint
                    if metadata_error is not None:
                        self.stop = "target_metadata_read_failed"
                        self.error = metadata_error
                        break
                    sample_at = max(
                        sample_at + self.spec["interval"],
                        time.monotonic() + self.spec["interval"],
                    )
                    delay = min(sample_at, deadline) - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
                if self.stop == "capture_failed":
                    self.stop = "window_complete" if time.monotonic() >= deadline else "viewer_exited"
        except (RecorderError, ReaderError, OSError, ValueError, RecursionError) as error:
            self.stop = "capture_failed"
            self.error = str(error)[:512]
            try:
                self.event({"kind": "capture_failed", "at": self.stamp(), "detail": self.error})
            except RecorderError:
                pass
        return self.report()

    def report(self) -> int:
        os.close(self.stream)
        report = {
            "schemaVersion": 1,
            "project": self.spec["project"], "bead": self.spec["bead"],
            "pane": self.spec["pane"], "viewerPid": self.spec["pid"], "tty": self.spec["tty"],
            "bdiSha256": self.spec["bdi_sha256"], "configSha256": self.spec["config_sha256"],
            "captureSeconds": self.spec["seconds"], "intervalSeconds": self.spec["interval"],
            "records": self.records, "bytes": self.bytes, "bdiBytes": self.reader.bdi_bytes,
            "stopReason": self.stop, "error": self.error, "atomic": False,
            "limitations": [
                "Pane text and bdi projections are separate, non-atomic samples.",
                "Changes between sample times may be missed or ambiguous.",
                "The unfinished-bead projection omits closed-bead metadata; closed status is not acceptance.",
                "Only the requested bead subtree and its identity paths are retained.",
                "No pane history or pane input is read.",
            ],
            "endedAt": self.stamp(),
        }
        fd = os.open(self.run_dir / "report.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        return 0 if self.stop in {"window_complete", "viewer_exited"} else 2
