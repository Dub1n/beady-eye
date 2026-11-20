"""Process-group-bounded Herdr and bdi reads for one-shot capture."""

from __future__ import annotations

import os
import selectors
import signal
import subprocess
import time

from observe_work_pane_reader import (
    MAX_BDI_TOTAL,
    MAX_JSON,
    PinnedReader,
    ReaderError,
)


class SweepReader(PinnedReader):
    """Use the recorder's identity checks with bounded process-tree cleanup."""

    def __init__(self, spec):
        super().__init__(spec)
        self.tree_sampled_at: str | None = None
        self.brief_sampled_at: str | None = None

    def herdr(self, args: list[str], deadline: float, limit: int = 1024 * 1024) -> str:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReaderError("capture window ended")
        try:
            child = subprocess.Popen(
                ["herdr", *args],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=os.environ.copy(),
                start_new_session=True,
                close_fds=True,
            )
        except OSError as error:
            raise ReaderError(f"could not start Herdr read: {error}") from error
        try:
            stdout, _ = child.communicate(timeout=min(3.0, remaining))
            if child.returncode:
                raise ReaderError("Herdr read exited unsuccessfully")
            if len(stdout) > limit:
                raise ReaderError("Herdr response exceeded its byte limit")
            return stdout.decode("utf-8")
        except (OSError, subprocess.SubprocessError, ReaderError, UnicodeError) as error:
            self._stop(child)
            if isinstance(error, ReaderError):
                raise
            raise ReaderError(f"Herdr read failed: {error}") from error

    def bounded_bdi(self, args: list[str], deadline: float) -> bytes:
        if "--all" in args:
            self.tree_sampled_at = self.stamp()
        elif "--beads" in args:
            self.brief_sampled_at = self.stamp()
        if deadline <= time.monotonic():
            raise ReaderError("capture window ended")
        limit = min(MAX_JSON, MAX_BDI_TOTAL - self.bdi_bytes)
        if limit <= 0:
            raise ReaderError("bounded bdi read budget reached")
        try:
            child = subprocess.Popen(
                args,
                cwd=self.spec["cwd"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=os.environ.copy(),
                start_new_session=True,
                close_fds=True,
            )
        except OSError as error:
            raise ReaderError(f"could not start pinned bdi read: {error}") from error
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
            child.wait(timeout=max(0.0, deadline - time.monotonic()))
            if child.returncode:
                raise ReaderError("pinned bdi read exited unsuccessfully")
            output = bytes(buffers[child.stdout])
            self.bdi_bytes += len(output)
            return output
        except (OSError, subprocess.SubprocessError, ReaderError) as error:
            self._stop(child)
            if isinstance(error, ReaderError):
                raise
            raise ReaderError(f"pinned bdi read failed: {error}") from error
        finally:
            selector.close()

    @staticmethod
    def _stop(child: subprocess.Popen[bytes]) -> None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
