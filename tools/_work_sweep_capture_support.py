"""Private-input qualification and atomic output for work-sweep capture."""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import time
from pathlib import Path
from typing import Final

from observe_work_pane_projection import Json

MAX_INPUT: Final = 1024 * 1024
SAFE_ID: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class CaptureError(RuntimeError):
    """The existing viewer cannot be safely sampled or its output retained."""


def read_document(path: Path) -> dict[str, Json]:
    """Read one owned, private, bounded JSON object without following links."""
    parent_info = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != os.getuid()
        or parent_info.st_mode & 0o077
    ):
        raise CaptureError("manifest and report must be in an owned private directory")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise CaptureError(f"cannot open private input document: {path.name}") from error
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > MAX_INPUT
        ):
            raise CaptureError(f"unsafe or oversized input document: {path.name}")
        raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise CaptureError(f"unsafe or oversized input document: {path.name}")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise CaptureError(f"input document is not a JSON object: {path.name}")
    return value


def text(value: Json, key: str) -> str:
    """Read one required non-empty string from a parsed JSON object."""
    result = value.get(key) if isinstance(value, dict) else None
    if not isinstance(result, str) or not result:
        raise CaptureError(f"manifest omitted {key}")
    return result


def target(value: str) -> tuple[str, str]:
    """Parse an exact project-qualified full bead identity."""
    project, separator, bead = value.partition(":")
    if (
        not separator
        or not SAFE_ID.fullmatch(project)
        or not SAFE_ID.fullmatch(bead)
    ):
        raise CaptureError("target must be project:full-bead-id")
    return project, bead


def validate_output(path: Path) -> None:
    """Require a fresh path under a private directory owned by this user."""
    parent = path.parent
    parent_info = parent.lstat()
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != os.getuid()
        or parent_info.st_mode & 0o077
        or parent.resolve(strict=True) != parent
    ):
        raise CaptureError("output parent must be an owned private directory")
    if path.exists() or path.is_symlink():
        raise CaptureError("output must be a new file")


def publish(path: Path, payload: dict[str, Json], deadline: float) -> None:
    """Write privately, then atomically expose only a complete JSON file."""
    encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    if time.monotonic() >= deadline:
        raise CaptureError("20-second capture budget expired before output publication")
    fd, temporary_name = tempfile.mkstemp(prefix=".work-sweep-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        if time.monotonic() >= deadline:
            raise CaptureError("20-second capture budget expired before output publication")
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
