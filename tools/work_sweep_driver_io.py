"""Bounded, private local inputs for the opt-in sweep driver."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat

PHASES = ("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")
MAX_DOCUMENT = 1024 * 1024
MAX_ADMISSION_CACHES = 64
MAX_ADMISSION_ROWS = 128
MAX_ADMISSION_BYTES = 2 * 1024 * 1024


def read_private(path: Path, limit: int = MAX_DOCUMENT) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError(f"unsafe private file: {path.name}")
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError(f"file exceeds limit: {path.name}")
    return value


def mapping(path: Path) -> tuple[dict, str]:
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("mapping must be absolute")
    raw = read_private(path)
    value = json.loads(raw)
    if (value.get("version") != 1 or not isinstance(value.get("project"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value["project"])):
        raise ValueError("invalid mapping version or project")
    for key in ("projectRoot", "taskDirectory", "manifest"):
        item = value.get(key)
        if (not isinstance(item, str) or not os.path.isabs(item) or os.path.normpath(item) != item
                or Path(item).resolve() != Path(item)):
            raise ValueError(f"mapping requires canonical absolute {key}")
    if not isinstance(value.get("rootSession"), str) or not value["rootSession"]:
        raise ValueError("mapping requires rootSession")
    observer = value.get("observerDirectory")
    if observer is not None and (not isinstance(observer, str) or not os.path.isabs(observer)
                                 or os.path.normpath(observer) != observer
                                 or Path(observer).resolve() != Path(observer)):
        raise ValueError("observerDirectory must be canonical and absolute")
    control = value.get("controlRecord")
    if control is not None and (not isinstance(control, str) or not os.path.isabs(control)
                                or os.path.normpath(control) != control
                                or Path(control).resolve() != Path(control)):
        raise ValueError("controlRecord must be canonical and absolute")
    gates = value.get("gates")
    if not isinstance(gates, list) or len(gates) != len(PHASES):
        raise ValueError("mapping requires every ordered gate and final target")
    for expected, gate in zip(PHASES, gates):
        if (not isinstance(gate, dict) or gate.get("phase") != expected
                or not isinstance(gate.get("bead"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", gate["bead"])):
            raise ValueError("invalid gate identity or order")
        for key in ("record", "receiptRoot"):
            item = gate.get(key)
            if (not isinstance(item, str) or not os.path.isabs(item)
                    or os.path.normpath(item) != item or Path(item).resolve() != Path(item)):
                raise ValueError(f"gate requires canonical absolute {key}")
    return value, hashlib.sha256(raw).hexdigest()


def accepted(gate: dict, project: str) -> tuple[str | None, str]:
    """Return a verified receipt fingerprint, not an independent acceptance verdict."""
    try:
        document = json.loads(read_private(Path(gate["record"])))
    except FileNotFoundError:
        return None, "gate_export_missing"
    rows = document if isinstance(document, list) else [document]
    matches = [row for row in rows if isinstance(row, dict) and row.get("id") == gate["bead"]
               and row.get("project", project) == project]
    if len(matches) != 1:
        return None, "gate_export_identity_unknown"
    issue = matches[0]
    if issue.get("status") != "closed":
        return None, "gate_not_closed"
    metadata = issue.get("metadata") or {}
    if not isinstance(metadata, dict):
        return None, "accepted_proof_missing"
    work = metadata.get("qrclipWork")
    if isinstance(work, str):
        work = json.loads(work)
    if not isinstance(work, dict) or not isinstance(work.get("accepted"), dict):
        return None, "accepted_proof_missing"
    proof = work["accepted"]
    receipt = proof.get("receipt")
    if proof.get("passed") is not True or not isinstance(receipt, dict):
        return None, "accepted_proof_missing"
    name, digest = receipt.get("path"), receipt.get("sha256")
    if not isinstance(name, str) or not isinstance(digest, str):
        return None, "receipt_pointer_missing"
    root = Path(gate["receiptRoot"])
    path = root / name
    if path.is_absolute() and (not root.is_absolute() or path.resolve() != path
                               or not path.is_relative_to(root)):
        return None, "receipt_pointer_unsafe"
    try:
        raw = read_private(path)
    except FileNotFoundError:
        return None, "receipt_missing"
    if hashlib.sha256(raw).hexdigest() != digest:
        return None, "receipt_digest_mismatch"
    return digest, "recorded_accepted_proof"


def frame_snapshot(directory: str | None) -> tuple[list[dict], list[str]]:
    if directory is None:
        return [], ["observer_source_not_configured"]
    root = Path(directory)
    try:
        info = root.lstat()
        if (root.resolve() != root or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError("unsafe observer directory")
        frames, total = [], 0
        with os.scandir(root) as entries:
            for count, entry in enumerate(entries, 1):
                if count > 4096:
                    raise ValueError("observer directory entry limit exceeded")
                if not (entry.name.startswith("frame-") and entry.name.endswith(".json")):
                    continue
                if len(frames) == 32:
                    raise ValueError("observer frame limit exceeded")
                data = read_private(root / entry.name, 256 * 1024)
                total += len(data)
                if total > 1024 * 1024:
                    raise ValueError("observer byte limit exceeded")
                frames.append(json.loads(data))
        return frames, [] if frames else ["observer_source_empty"]
    except FileNotFoundError:
        return [], ["observer_source_missing"]


def admission_snapshot(directory: str | None, project: str,
                       task_directory: str) -> tuple[list[dict], list[str]]:
    """Read bounded per-parent continuity caches for one configured project."""
    if directory is None:
        return [], []
    root = Path(directory)
    try:
        info = root.lstat()
        if (root.resolve() != root or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError("unsafe observer directory")
        caches, total = [], 0
        with os.scandir(root) as entries:
            for count, entry in enumerate(entries, 1):
                if count > 4096:
                    raise ValueError("observer directory entry limit exceeded")
                if not (entry.name.startswith("admission-") and entry.name.endswith(".json")):
                    continue
                if len(caches) == MAX_ADMISSION_CACHES:
                    raise ValueError("admission cache count exceeds limit")
                data = read_private(root / entry.name, 256 * 1024)
                total += len(data)
                if total > MAX_ADMISSION_BYTES:
                    raise ValueError("admission cache bytes exceed limit")
                cache = json.loads(data)
                if not isinstance(cache, dict):
                    raise ValueError("admission cache must be an object")
                scope, parent, rows = cache.get("scope"), cache.get("parent"), cache.get("admissions")
                if (cache.get("version") != 1
                        or scope != {"project": project, "taskDirectory": task_directory}):
                    continue
                if (not isinstance(parent, str) or not parent or len(parent) > 512
                        or not isinstance(rows, list) or len(rows) > MAX_ADMISSION_ROWS
                        or any(not isinstance(row, dict) or row.get("parent") != parent
                               for row in rows)):
                    raise ValueError("admission cache rows or parent are invalid")
                cache_key = json.dumps([scope, parent], separators=(",", ":"),
                                       ensure_ascii=False).encode()
                expected_name = "admission-" + hashlib.sha256(cache_key).hexdigest() + ".json"
                if entry.name != expected_name:
                    raise ValueError("admission cache filename does not match its scope")
                caches.append(cache)
        return caches, []
    except FileNotFoundError:
        return [], ["observer_source_missing"]


def controls(config: dict) -> tuple[list[dict], list[str]]:
    """Read scoped operator-published control records with exact evidence pins."""
    name = config.get("controlRecord")
    if name is None:
        return [], ["control_source_not_configured"]
    try:
        payload = json.loads(read_private(Path(name)))
    except FileNotFoundError:
        return [], ["control_source_missing"]
    if (payload.get("version") != 1 or any(payload.get(key) != config[key]
            for key in ("project", "projectRoot", "taskDirectory", "rootSession"))):
        return [], ["control_scope_mismatch"]
    rows = payload.get("events")
    if not isinstance(rows, list) or len(rows) > 256:
        raise ValueError("control event count exceeds bound")
    result, gaps, ids = [], [], set()
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                or len(row["id"]) > 160 or row.get("kind") not in
                ("disposition", "park", "resume", "handoff") or row["id"] in ids):
            raise ValueError("invalid or duplicate scoped control event")
        ids.add(row["id"])
        evidence = row.get("evidence")
        if not isinstance(evidence, dict):
            gaps.append("control_evidence_missing")
            continue
        path, digest = evidence.get("path"), evidence.get("sha256")
        if (not isinstance(path, str) or not os.path.isabs(path)
                or os.path.normpath(path) != path or not isinstance(digest, str)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            gaps.append("control_evidence_invalid")
            continue
        if Path(path).resolve() != Path(path):
            gaps.append("control_evidence_invalid")
            continue
        try:
            raw = read_private(Path(path))
        except FileNotFoundError:
            gaps.append("control_evidence_missing")
            continue
        if hashlib.sha256(raw).hexdigest() != digest:
            gaps.append("control_evidence_digest_mismatch")
            continue
        result.append(row)
    return result, sorted(set(gaps))
