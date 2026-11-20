"""Capture one bounded sample from an already running, pinned bdi viewer."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from _work_sweep_capture_support import (
    CaptureError,
    publish,
    read_document,
    target as parse_target,
    text,
    validate_output,
)
from _work_sweep_reader import SweepReader
from observe_work_pane_projection import Json
from observe_work_pane_reader import ReaderError

MAX_CAPTURE_SECONDS: Final = 20.0
OUTPUT_RESERVE_SECONDS: Final = 1.0
SAFE_SHA256: Final = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class CaptureResult:
    """One independently sampled viewer frame and its output disposition."""

    output: Path
    project: str
    bead: str
    status: str
    visible: str
    tree: dict[str, Json]
    target: dict[str, Json]
    error: str | None
    elapsed_seconds: float
    pane_sampled_at: str
    tree_sampled_at: str | None
    bead_facts_sampled_at: str | None
    viewer_target: str


def capture_once(
    manifest: Path,
    target: str,
    output: Path,
    *,
    expected_sha256: str,
) -> CaptureResult:
    """Capture one visible sample and scoped tree/brief reads within 20 seconds."""
    started = time.monotonic()
    deadline = started + MAX_CAPTURE_SECONDS
    if not SAFE_SHA256.fullmatch(expected_sha256):
        raise CaptureError("expected_sha256 must be lowercase SHA-256")
    project, bead = parse_target(target)
    if not manifest.is_absolute() or not output.is_absolute():
        raise CaptureError("manifest and output paths must be absolute")
    validate_output(output)

    spec = read_document(manifest)
    report = read_document(manifest.with_name("report.json"))
    if time.monotonic() >= deadline:
        raise CaptureError("20-second capture budget expired while reading evidence")
    if spec.get("schemaVersion") != 1 or report.get("schemaVersion") != 1:
        raise CaptureError("unsupported startup manifest or report schema")

    pinned_hash = text(spec, "bdi_sha256")
    if pinned_hash != expected_sha256 or report.get("bdiSha256") != expected_sha256:
        raise CaptureError("stored viewer pin does not match the trusted expected SHA-256")
    stored_project = text(spec, "project")
    required_identity = {
        "project": stored_project,
        "bead": text(spec, "bead"),
        "pane": text(spec, "pane"),
        "viewerPid": spec.get("pid"),
        "tty": text(spec, "tty"),
        "bdiSha256": pinned_hash,
        "configSha256": spec.get("config_sha256"),
    }
    if any(report.get(key) != value for key, value in required_identity.items()):
        raise CaptureError("startup report belongs to a different viewer identity")
    argv = spec.get("argv")
    config = spec.get("config")
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise CaptureError("manifest omitted the pinned viewer argv")
    project_flags = [index for index, arg in enumerate(argv) if arg == "--project"]
    config_flags = [index for index, arg in enumerate(argv) if arg == "--config"]
    if (
        len(project_flags) != 1
        or project_flags[0] + 1 >= len(argv)
        or argv[project_flags[0] + 1] != stored_project
        or not argv
        or "--all" not in argv
        or argv[-1] != text(spec, "bead")
        or (config is None and config_flags)
        or (
            config is not None
            and (
                len(config_flags) != 1
                or config_flags[0] + 1 >= len(argv)
                or argv[config_flags[0] + 1] != config
            )
        )
    ):
        raise CaptureError("manifest project, bead, or config do not match the viewer argv")
    if project != stored_project:
        raise CaptureError("target project differs from the startup viewer project")
    if config is not None and not isinstance(config, str):
        raise CaptureError("manifest contains an invalid config path")
    if (
        not Path(text(spec, "bdi")).is_absolute()
        or not Path(text(spec, "config_watch")).is_absolute()
        or (config is not None and not Path(config).is_absolute())
        or (config is not None and spec.get("config_watch") != config)
    ):
        raise CaptureError("manifest executable and config paths must be absolute")
    if not isinstance(spec.get("pid"), int) or not isinstance(
        spec.get("start_ticks"), str
    ):
        raise CaptureError("manifest omitted the viewer process start identity")

    reader_spec = dict(spec)
    reader_spec["bead"] = bead
    reader = SweepReader(reader_spec)
    read_deadline = deadline - OUTPUT_RESERVE_SECONDS
    try:
        if not reader.viewer(read_deadline):
            raise CaptureError("the pinned viewer is no longer running")
        reader.check_pins()
        if time.monotonic() >= read_deadline:
            raise ReaderError("capture window ended before the visible read")
        pane_sampled_at = reader.stamp()
        visible = reader.visible(read_deadline)
        if not reader.viewer(read_deadline):
            raise CaptureError("the pinned viewer exited after the visible read")
    except (ReaderError, OSError, ValueError, TimeoutError) as error:
        raise CaptureError(str(error)) from error

    tree_sampled_at: str | None = None
    bead_facts_sampled_at: str | None = None
    try:
        tree, metadata, tree_sampled_at, bead_facts_sampled_at, metadata_error = (
            reader.target_facts(read_deadline)
        )
    except (ReaderError, OSError, ValueError, TimeoutError) as error:
        tree = {"available": False, "reason": "tree_read_failed"}
        metadata = {"available": False, "reason": "target_metadata_read_failed"}
        metadata_error = str(error)[:512]
    tree_sampled_at = tree_sampled_at or reader.tree_sampled_at
    bead_facts_sampled_at = bead_facts_sampled_at or reader.brief_sampled_at

    error = metadata_error
    status = "complete"
    if metadata_error is not None:
        status = "partial"
    elif metadata.get("available") is not True:
        status = "partial"
    if time.monotonic() >= read_deadline:
        status = "partial"
        error = error or "capture budget reached after the last completed read"

    result = CaptureResult(
        output=output,
        project=project,
        bead=bead,
        status=status,
        visible=visible,
        tree=tree,
        target=metadata,
        error=error,
        elapsed_seconds=time.monotonic() - started,
        pane_sampled_at=pane_sampled_at,
        tree_sampled_at=tree_sampled_at,
        bead_facts_sampled_at=bead_facts_sampled_at,
        viewer_target=required_identity["bead"],
    )
    payload: dict[str, Json] = {
        "schemaVersion": 1,
        "project": project,
        "bead": bead,
        "pane": required_identity["pane"],
        "viewerPid": required_identity["viewerPid"],
        "tty": required_identity["tty"],
        "bdiSha256": pinned_hash,
        "viewerExecutable": text(spec, "bdi"),
        "viewerCwd": text(spec, "cwd"),
        "viewerStartTicks": text(spec, "start_ticks"),
        "configSha256": required_identity["configSha256"],
        "queriedTarget": {"project": project, "bead": bead},
        "paneSampledAt": pane_sampled_at,
        "treeSampledAt": tree_sampled_at,
        "beadFactsSampledAt": bead_facts_sampled_at,
        "viewerTarget": {
            "project": stored_project,
            "bead": result.viewer_target,
        },
        "status": status,
        "visible": visible,
        "tree": tree,
        "target": metadata,
        "error": error,
        "atomic": False,
        "elapsedSeconds": result.elapsed_seconds,
    }
    try:
        validate_output(output)
        publish(output, payload, deadline)
    except OSError as error:
        raise CaptureError(f"cannot write private capture output: {error}") from error
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture one bounded sample from an already running pinned viewer."
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--target", required=True, help="exact project:full-bead-id")
    parser.add_argument("--output", required=True, type=Path, help="new private JSON file")
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    try:
        result = capture_once(
            args.manifest,
            args.target,
            args.output,
            expected_sha256=args.expected_sha256,
        )
    except (CaptureError, OSError, ValueError, ReaderError) as error:
        parser.exit(2, f"work-sweep-capture: {error}\n")
    print(json.dumps({
        "status": result.status,
        "output": str(result.output),
        "project": result.project,
        "bead": result.bead,
    }))
    return 0 if result.status == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
