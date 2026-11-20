"""Argument validation and in-place launch of the pinned viewer."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from observe_work_pane_capture import Capture, RecorderError
from observe_work_pane_reader import digest, process_start_ticks

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


@dataclass(frozen=True, slots=True)
class Options:
    bdi: Path
    sha256: str
    project: str
    bead: str
    output_dir: Path
    config: Path | None
    seconds: int
    interval: int


def launch(options: Options) -> None:
    if (
        not options.bdi.is_absolute()
        or not options.output_dir.is_absolute()
        or (options.config is not None and not options.config.is_absolute())
        or not SAFE_NAME.fullmatch(options.project)
        or not SAFE_NAME.fullmatch(options.bead)
        or not re.fullmatch(r"[0-9a-f]{64}", options.sha256)
        or not 1 <= options.seconds <= 120
        or not 1 <= options.interval <= 30
        or options.interval > options.seconds
    ):
        raise RecorderError("invalid pinned viewer, identity, output path, or capture bounds")
    try:
        bdi = options.bdi.resolve(strict=True)
        if not bdi.is_file() or not os.access(bdi, os.X_OK) or digest(bdi) != options.sha256:
            raise RecorderError("--bdi is not the executable matching --sha256")
        if options.config is not None and not options.config.is_file():
            raise RecorderError("--config must name an existing file")
        config = options.config.resolve(strict=True) if options.config is not None else None
    except OSError as error:
        raise RecorderError(f"cannot resolve pinned viewer inputs: {error}") from error
    argv = [str(bdi)]
    if config is not None:
        argv.extend(["--config", str(config)])
    argv.extend(["--project", options.project, "--all", options.bead])
    started = time.monotonic()
    run_dir: Path | None = None
    helper: subprocess.Popen[bytes] | None = None
    try:
        parent = options.output_dir
        parent_info = parent.lstat()
        if (
            not parent.is_dir()
            or parent.is_symlink()
            or parent_info.st_uid != os.getuid()
            or parent_info.st_mode & 0o777 != 0o700
            or parent.resolve(strict=True) != parent
        ):
            raise RecorderError("--output-dir must be an owned, non-symlink 0700 directory")
        run_dir = Path(tempfile.mkdtemp(prefix="observe-work-pane-", dir=parent))
        if os.environ.get("HERDR_ENV") != "1":
            raise RecorderError("run from the dedicated Herdr pane")
        pane = os.environ.get("HERDR_PANE_ID", "")
        workspace = os.environ.get("HERDR_WORKSPACE_ID", "")
        if not pane or not workspace or not pane.startswith(workspace + ":"):
            raise RecorderError("Herdr did not identify this pane and workspace")
        if not os.isatty(0) or not os.isatty(1):
            raise RecorderError("the dedicated pane must provide an interactive terminal")
        tty = os.ttyname(0)
        tty_info = os.fstat(0)
        if not re.fullmatch(r"/dev/pts/[0-9]+", tty):
            raise RecorderError("the invoking pane is not attached to a PTY")
        config_watch = config or (Path.home() / ".config/beady-eye/config.toml")
        try:
            config_hash = digest(config_watch)
        except FileNotFoundError:
            config_hash = None
        spec = {
            "schemaVersion": 1, "started": started, "startedAt": Capture.stamp(),
            "seconds": options.seconds, "interval": options.interval,
            "bdi": str(bdi), "bdi_sha256": options.sha256,
            "config": str(config) if config is not None else None,
            "config_watch": str(config_watch), "config_sha256": config_hash,
            "project": options.project, "bead": options.bead,
            "cwd": str(Path.cwd().resolve()), "pane": pane, "workspace": workspace,
            "pid": os.getpid(), "start_ticks": process_start_ticks(os.getpid()),
            "tty": tty, "tty_dev": tty_info.st_dev, "tty_rdev": tty_info.st_rdev,
            "tty_ino": tty_info.st_ino, "argv": argv,
        }
        for name, value in (("manifest.json", spec), ("observations.jsonl", None)):
            fd = os.open(run_dir / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                if value is not None:
                    json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
                    output.write("\n")
        try:
            helper = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve().with_name("observe-work-pane.py")),
                 "--observer-helper", str(run_dir)],
                cwd=spec["cwd"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, env=os.environ.copy(),
                start_new_session=True, close_fds=True,
            )
        except OSError as error:
            _setup_report(run_dir, "observer_start_failed", error, options.sha256)
            print(
                f"observe-work-pane: capture unavailable: {error}; private report in {run_dir}",
                file=sys.stderr,
            )
        else:
            print(f"observe-work-pane: private run directory {run_dir}", file=sys.stderr)
    except (RecorderError, OSError) as error:
        if helper is not None and helper.poll() is None:
            helper.kill()
            helper.wait()
        report_hint = f"; private report in {run_dir}" if run_dir is not None else ""
        print(
            f"observe-work-pane: capture unavailable: {error}{report_hint}; "
            "launching pinned bdi normally",
            file=sys.stderr,
        )
        if run_dir is not None and not (run_dir / "report.json").exists():
            _setup_report(run_dir, "capture_setup_failed", error, options.sha256)
    try:
        os.execv(str(bdi), argv)
    except OSError as error:
        if helper is not None and helper.poll() is None:
            helper.kill()
            helper.wait()
        raise RecorderError(f"could not exec pinned bdi: {error}") from error


def _setup_report(run_dir: Path, reason: str, error: OSError, sha256: str) -> None:
    report = {
        "schemaVersion": 1, "stopReason": reason, "error": str(error)[:512],
        "bdiSha256": sha256,
    }
    fd = os.open(run_dir / "report.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(report, output, separators=(",", ":"))
        output.write("\n")
