"""Read only the invoking pane and bounded bdi projections."""

from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import subprocess
import time
from pathlib import Path

from observe_work_pane_projection import Json, scoped_snapshot, target_metadata

MAX_JSON = 8 * 1024 * 1024
MAX_BDI_TOTAL = 128 * 1024 * 1024
MARKER = re.compile(r"(?:^|\s)(?:q\s+quit|\?\s+keys)(?:\s|$)")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class ReaderError(RuntimeError):
    """A pinned pane or bounded command read failed."""


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def process_start_ticks(pid: int) -> str:
    fields = Path(f"/proc/{pid}/stat").read_text(encoding="ascii").rsplit(")", 1)[1].split()
    if len(fields) <= 19:
        raise ReaderError("cannot bind viewer process start identity")
    return fields[19]


class PinnedReader:
    """Bind every read to one pane, PID, executable, cwd, and PTY."""

    def __init__(self, spec: dict[str, Json]) -> None:
        self.spec = spec
        self.exe_identity: tuple[int, int, int, int] | None = None
        self.bdi_bytes = 0

    def herdr(self, args: list[str], deadline: float, limit: int = 1024 * 1024) -> str:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReaderError("capture window ended")
        result = subprocess.run(
            ["herdr", *args], check=True, capture_output=True, text=True,
            timeout=min(3.0, remaining), env=os.environ.copy(),
        )
        if len(result.stdout.encode()) > limit:
            raise ReaderError("Herdr response exceeded its byte limit")
        return result.stdout

    def viewer(self, deadline: float) -> bool:
        response = json.loads(self.herdr(
            ["pane", "process-info", "--pane", self.spec["pane"]], deadline
        ))
        info = response.get("result", {}).get("process_info")
        if not isinstance(info, dict) or info.get("pane_id") != self.spec["pane"]:
            raise ReaderError("Herdr no longer identifies the exact invoking pane")
        processes = info.get("foreground_processes")
        if not isinstance(processes, list):
            raise ReaderError("Herdr omitted foreground process identity")
        process = next((
            item for item in processes
            if isinstance(item, dict) and item.get("pid") == self.spec["pid"]
        ), None)
        if process is None:
            return False
        pid = self.spec["pid"]
        if process_start_ticks(pid) != self.spec["start_ticks"]:
            raise ReaderError("invoking pane PID changed since recorder launch")
        argv = process.get("argv")
        if not isinstance(argv, list) or not argv:
            raise ReaderError("Herdr omitted viewer arguments")
        if argv[0] != self.spec["bdi"]:
            return False
        if argv != self.spec["argv"] or process.get("cwd") != self.spec["cwd"]:
            raise ReaderError("invoking pane process changed from the pinned viewer")
        executable = Path(f"/proc/{pid}/exe")
        exe_stat = executable.stat()
        identity = (exe_stat.st_dev, exe_stat.st_ino, exe_stat.st_size, exe_stat.st_mtime_ns)
        if self.exe_identity is None:
            if digest(executable) != self.spec["bdi_sha256"]:
                raise ReaderError("running viewer does not match the pinned binary")
            self.exe_identity = identity
        elif identity != self.exe_identity:
            raise ReaderError("viewer PID changed its executable")
        tty_fd = Path(f"/proc/{pid}/fd/0")
        tty = os.readlink(tty_fd)
        tty_stat = tty_fd.stat()
        if (
            tty != self.spec["tty"]
            or tty_stat.st_dev != self.spec["tty_dev"]
            or tty_stat.st_rdev != self.spec["tty_rdev"]
            or tty_stat.st_ino != self.spec["tty_ino"]
        ):
            raise ReaderError("viewer PID moved to a different terminal")
        return True

    def check_pins(self) -> None:
        if digest(Path(self.spec["bdi"])) != self.spec["bdi_sha256"]:
            raise ReaderError("bdi executable changed during capture")
        config_path = Path(self.spec["config_watch"])
        try:
            config_hash = digest(config_path)
        except FileNotFoundError:
            config_hash = None
        if config_hash != self.spec["config_sha256"]:
            raise ReaderError("bdi configuration changed during capture")

    def visible(self, deadline: float) -> str:
        return self.herdr(
            ["pane", "read", self.spec["pane"], "--source", "visible", "--lines", "200",
             "--format", "text", "--raw"],
            deadline,
            256 * 1024,
        )

    def bounded_bdi(self, args: list[str], deadline: float) -> bytes:
        if deadline <= time.monotonic():
            raise ReaderError("capture window ended")
        limit = min(MAX_JSON, MAX_BDI_TOTAL - self.bdi_bytes)
        if limit <= 0:
            raise ReaderError("bounded bdi read budget reached")
        with subprocess.Popen(
            args, cwd=self.spec["cwd"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=os.environ.copy(),
        ) as child:
            assert child.stdout is not None and child.stderr is not None
            selector = selectors.DefaultSelector()
            buffers = {child.stdout: bytearray(), child.stderr: bytearray()}
            for pipe in buffers:
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ)
            try:
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ReaderError("capture window ended during bdi read")
                    for key, _ in selector.select(remaining):
                        pipe = key.fileobj
                        chunk = os.read(pipe.fileno(), 65536)
                        if not chunk:
                            selector.unregister(pipe)
                            continue
                        byte_limit = limit if pipe is child.stdout else 16 * 1024
                        if len(buffers[pipe]) + len(chunk) > byte_limit:
                            raise ReaderError("bdi response exceeded its byte limit")
                        buffers[pipe].extend(chunk)
                if child.wait(timeout=max(0.05, deadline - time.monotonic())):
                    raise ReaderError("pinned bdi read exited unsuccessfully")
                output = bytes(buffers[child.stdout])
                self.bdi_bytes += len(output)
                return output
            except (OSError, subprocess.SubprocessError, ReaderError):
                if child.poll() is None:
                    child.kill()
                child.wait()
                raise
            finally:
                selector.close()

    def bdi_args(self, *flags: str) -> list[str]:
        args = [self.spec["bdi"]]
        if self.spec["config"] is not None:
            args.extend(["--config", self.spec["config"]])
        args.extend(["--project", self.spec["project"], *flags, self.spec["bead"]])
        return args

    def target_facts(
        self, deadline: float
    ) -> tuple[dict[str, Json], dict[str, Json], str, str | None, str | None]:
        self.check_pins()
        if not self.viewer(deadline):
            raise ReaderError("viewer exited before the scoped tree read")
        tree_at = self.stamp()
        tree_value = json.loads(self.bounded_bdi(self.bdi_args("--all", "--json"), deadline))
        selected = scoped_snapshot(tree_value, self.spec["project"], self.spec["bead"])
        if not self.viewer(deadline):
            raise ReaderError("viewer exited during the scoped tree read")
        try:
            metadata_at = self.stamp()
            detail_value = json.loads(self.bounded_bdi(self.bdi_args("--beads", "--brief"), deadline))
            metadata = target_metadata(detail_value, self.spec["project"], self.spec["bead"])
            self.check_pins()
            if not self.viewer(deadline):
                raise ReaderError("viewer exited during the target detail read")
            return selected, metadata, tree_at, metadata_at, None
        except (OSError, subprocess.SubprocessError, ReaderError, ValueError) as error:
            return (
                selected,
                {"available": False, "reason": "target_metadata_read_failed"},
                tree_at,
                None,
                str(error)[:512],
            )

    @staticmethod
    def stamp() -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat()

    def ready(self, deadline: float) -> bool:
        while time.monotonic() < deadline:
            self.check_config()
            if self.viewer(deadline):
                screen = self.visible(deadline)
                if self.viewer(deadline) and MARKER.search(ANSI.sub("", screen)):
                    self.check_config()
                    return True
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        return False

    def check_config(self) -> None:
        config_path = Path(self.spec["config_watch"])
        try:
            config_hash = digest(config_path)
        except FileNotFoundError:
            config_hash = None
        if config_hash != self.spec["config_sha256"]:
            raise ReaderError("bdi configuration changed during viewer startup")
