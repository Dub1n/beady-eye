#!/usr/bin/env python3
# noqa: SIZE_OK - one transactional CLI is constrained to the two assigned modules.
"""Opt-in sweep of one pinned viewer using private mapped evidence exports.

Only ``run`` captures; other commands are offline. Gate exports and optional
scoped controls are bounded file reads, never tracker polling.
"""
from __future__ import annotations

import argparse
from collections import Counter
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

from work_sweep_capture import capture_once
from work_sweep_driver_io import (
    accepted, admission_snapshot, controls, frame_snapshot, mapping, read_private,
)
from work_sweep_events import admission_event_id, derive_events
from work_sweep_schedule import PHASES, Event, EventKind, SweepScheduler

MAX_DOCUMENT = 1024 * 1024
MAX_FRAMES = 64
MAX_FRAME = 256 * 1024
MAX_TOTAL = 2 * 1024 * 1024
MAX_ADMISSION_SEEN = 1024


def admission_ids(caches: list[dict], project: str, task_directory: str) -> set[str]:
    """Return bounded stable identities for rows in validated scoped caches."""
    return {
        identity
        for cache in caches
        for row in cache["admissions"]
        if (identity := admission_event_id(project, task_directory, row)) is not None
    }


def private_directory(path: Path) -> None:
    info = path.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("directory must be canonical, owned and mode 0700")


def atomic_state(directory: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix=".sweep-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, directory / "state.json")
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def startup(args: argparse.Namespace) -> dict:
    private_directory(args.state_dir)
    if not args.manifest.is_absolute():
        raise ValueError("manifest must be absolute")
    private_directory(args.manifest.parent)
    manifest_bytes = read_private(args.manifest, MAX_DOCUMENT)
    report_bytes = read_private(args.manifest.with_name("report.json"), MAX_DOCUMENT)
    manifest, report = json.loads(manifest_bytes), json.loads(report_bytes)
    if manifest.get("schemaVersion") != 1 or report.get("schemaVersion") != 1:
        raise ValueError("unsupported startup evidence schema")
    bindings = {"project": "project", "bead": "bead", "pane": "pane",
                "pid": "viewerPid", "tty": "tty", "bdi_sha256": "bdiSha256",
                "config_sha256": "configSha256"}
    if any(manifest.get(left) != report.get(right) for left, right in bindings.items()):
        raise ValueError("startup manifest and report identity differ")
    if (not re.fullmatch(r"[0-9a-f]{64}", args.expected_sha256)
            or not manifest.get("project") or not manifest.get("bead") or not manifest.get("pane")
            or not manifest.get("pid") or not manifest.get("tty")
            or manifest.get("bdi_sha256") != args.expected_sha256):
        raise ValueError("startup identity or expected executable pin is missing")
    scheduler = SweepScheduler(args.budget)
    checkpoint, = scheduler.append(Event("startup", EventKind.START, 0))
    state = {
        "schemaVersion": 1,
        "startup": {"manifest": str(args.manifest),
                    "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                    "reportSha256": hashlib.sha256(report_bytes).hexdigest(),
                    "project": manifest["project"], "bead": manifest["bead"],
                    "stopReason": report.get("stopReason"), "records": report.get("records")},
        "scheduler": json.loads(scheduler.to_json()),
        "slots": {str(checkpoint.slot): {"phase": checkpoint.phase, "trigger": checkpoint.trigger,
                                       "status": "existing_startup"}},
        "liveAvailable": False,
        "gaps": ["mapping_not_bound"],
    }
    lock_fd = os.open(args.state_dir / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("unsafe lock file")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = args.state_dir / "state.json"
        if state_path.exists() or state_path.is_symlink():
            previous = json.loads(read_private(state_path, MAX_DOCUMENT))
            if (previous["startup"] != state["startup"]
                    or previous["scheduler"]["budget"] != args.budget):
                raise ValueError("state already belongs to different startup evidence")
            return previous
        atomic_state(args.state_dir, (json.dumps(state, sort_keys=True) + "\n").encode())
    return state


def inspect_frames(args: argparse.Namespace) -> dict:
    paths = []
    for directory in (args.previous_observer_dir, args.observer_dir):
        if directory is None:
            continue
        private_directory(directory)
        with os.scandir(directory) as entries:
            for count, entry in enumerate(entries, 1):
                if count > 4096:
                    raise ValueError("observer directory entry limit exceeded")
                if entry.name.startswith("frame-") and entry.name.endswith(".json"):
                    paths.append(directory / entry.name)
                    if len(paths) > MAX_FRAMES:
                        raise ValueError("observer frame count exceeds limit")
    frames, total = [], 0
    seen = {}
    for path in paths:
        data = read_private(path, MAX_FRAME)
        total += len(data)
        if total > MAX_TOTAL:
            raise ValueError("observer frame bytes exceed limit")
        frame = json.loads(data)
        key = (frame.get("epoch"), frame.get("sequence"))
        if key in seen:
            if seen[key] != frame:
                raise ValueError("conflicting observer frames for producer sequence")
            continue
        seen[key] = frame
        frames.append(frame)
    frames.sort(key=lambda frame: (frame.get("observedAt", ""), frame.get("sequence", 0)))
    caches, cache_gaps = admission_snapshot(
        str(args.observer_dir), args.project, args.task_directory
    )
    if not frames and not caches:
        return {"eventCounts": {}, "gaps": ["observer_source_empty"]}
    result = derive_events(frames, project=args.project, task_directory=args.task_directory,
                           project_root=args.project_root, root_session=args.root_session,
                           admission_caches=caches)
    return {"eventCounts": dict(Counter(event["kind"] for event in result["events"])),
            "gaps": sorted(set(result["gaps"] + cache_gaps))}


def run_sweep(args: argparse.Namespace) -> dict:
    config, config_hash = mapping(args.mapping)
    args.manifest = Path(config["manifest"])
    anchor = json.loads(read_private(args.manifest, MAX_DOCUMENT))
    if (anchor.get("project") != config["project"] or anchor.get("cwd") != config["projectRoot"]):
        raise ValueError("startup and mapping project or root disagree")
    startup(args)
    lock_fd = os.open(args.state_dir / "lock", os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(lock_fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("unsafe lock file")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(read_private(args.state_dir / "state.json", MAX_DOCUMENT))
        if state.get("mappingSha256", config_hash) != config_hash:
            raise ValueError("mapping changed since sweep started")
        scheduler = SweepScheduler.from_json(json.dumps(state["scheduler"]))
        stored_cursor = state.get("cursor", {"elapsed": 0, "nextTick": 300})
        if not isinstance(stored_cursor, dict):
            raise ValueError("persisted sweep cursor is invalid")
        cursor = stored_cursor.copy()
        if type(cursor.get("elapsed")) is not int or cursor["elapsed"] < 0:
            raise ValueError("persisted sweep cursor elapsed time is invalid")
        if scheduler.last_at is not None and cursor["elapsed"] < scheduler.last_at:
            raise ValueError("persisted sweep cursor precedes its event ledger")
        cursor["paused"] = scheduler.parked
        if not scheduler.parked:
            cursor.pop("pauseAt", None)
            pause_at = None
        else:
            pause_at = None
            for event in scheduler.events:
                if event.kind is EventKind.PAUSE and pause_at is None:
                    pause_at = event.at
                elif event.kind is EventKind.RESUME:
                    pause_at = None
            if pause_at is None:
                raise ValueError("paused sweep has no matching pause event")
            cursor["pauseAt"] = pause_at
        active_elapsed = scheduler.active_elapsed
        if scheduler.active and scheduler.last_at is not None:
            active_elapsed += cursor["elapsed"] - scheduler.last_at
        remaining = max(0, scheduler.next_tick - active_elapsed)
        cursor["nextTick"] = (pause_at if pause_at is not None else cursor["elapsed"]) + remaining

        state["cursor"] = cursor
        state["mappingSha256"] = config_hash
        state["liveAvailable"] = True
        if state.get("running"):
            state["clockRecovery"] = "active_elapsed_since_last_persist_unknown"
        state["running"] = True
        for entry in state["slots"].values():
            if entry["status"] == "reserved":
                entry["status"] = "missed_interrupted"
                state["interrupted"] = True
        atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
        if state.get("interrupted"):
            if not args.confirm_stopped:
                raise ValueError("interrupted capture requires confirmation it has stopped")
            state["interrupted"] = False
            atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
        if state.get("final"):
            state["running"] = False
            atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
            return state
        initial = cursor["elapsed"]
        started = time.monotonic()
        last_saved = initial
        previous, observer_gaps = frame_snapshot(config.get("observerDirectory"))
        initial_caches, initial_cache_gaps = admission_snapshot(
            config.get("observerDirectory"), config["project"], config["taskDirectory"]
        )
        state["gaps"] = sorted(set(state["gaps"] + initial_cache_gaps))
        if "admissionSeen" not in state:
            baseline = admission_ids(
                initial_caches, config["project"], config["taskDirectory"]
            )
            if len(baseline) > MAX_ADMISSION_SEEN:
                raise ValueError("admission identity baseline exceeds limit")
            state["admissionSeen"] = sorted(baseline)
        elif (not isinstance(state["admissionSeen"], list)
              or len(state["admissionSeen"]) > MAX_ADMISSION_SEEN
              or any(not isinstance(identity, str) for identity in state["admissionSeen"])):
            raise ValueError("persisted admission identity ledger is invalid")
        seen_admissions = set(state["admissionSeen"])
        atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
        prior_gates = {gate["phase"]: accepted(gate, config["project"])[0]
                       for gate in config["gates"]}
        control_initialized = False
        historical_controls: set[str] = set()

        def apply(event: Event, target: str, *, capture: bool,
                  missed: str = "missed_historical",
                  evidence: dict | None = None) -> bool:
            prior_phase = scheduler.phase
            prior_next_tick = scheduler.next_tick
            prior_parked = scheduler.parked
            checkpoints = scheduler.append(event)
            if (event.kind is EventKind.RESUME or scheduler.phase != prior_phase
                    or scheduler.next_tick != prior_next_tick
                    or scheduler.parked != prior_parked):
                remaining = max(0, scheduler.next_tick - scheduler.active_elapsed)
                base = cursor["pauseAt"] if cursor.get("paused") else event.at
                cursor["nextTick"] = base + remaining
            state["scheduler"] = json.loads(scheduler.to_json())
            state["missedTimerSlots"] = scheduler.missed_slots
            state["unusedSlots"] = scheduler.unused_slots
            for checkpoint in checkpoints:
                state["slots"][str(checkpoint.slot)] = {
                    "phase": checkpoint.phase, "trigger": checkpoint.trigger,
                    "at": checkpoint.at, "target": target,
                    "status": "reserved" if capture else missed,
                }
                if evidence is not None:
                    state["slots"][str(checkpoint.slot)]["evidence"] = evidence
                if checkpoint.phase == "FINAL" and checkpoint.trigger.startswith("final:"):
                    state["final"] = True
            atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
            for checkpoint in checkpoints:
                if not capture:
                    continue
                entry = state["slots"][str(checkpoint.slot)]
                output = args.state_dir / f"capture-{checkpoint.slot:03}.json"
                try:
                    result = capture_once(args.manifest, target, output,
                                          expected_sha256=args.expected_sha256)
                    entry["status"] = result.status
                    entry["output"] = str(output)
                except (OSError, ValueError, RuntimeError) as error:
                    entry["status"] = "failed"
                    entry["error"] = str(error)[:512]
                atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
            return bool(checkpoints and capture)

        while True:
            elapsed = initial + min(args.duration, int(time.monotonic() - started))
            cursor["elapsed"] = elapsed
            current_caches, cache_gaps = admission_snapshot(
                config.get("observerDirectory"), config["project"], config["taskDirectory"]
            )
            signals, control_gaps = controls(config)
            if not control_initialized and not control_gaps:
                historical_controls = {signal["id"] for signal in signals}
                control_initialized = True
            captured = False
            for signal in signals:
                event_id = "control:" + signal["id"]
                if event_id in {event.id for event in scheduler.events}:
                    continue
                kind = signal["kind"]
                phase_index = PHASES.index(scheduler.phase)
                gate = config["gates"][phase_index]
                target = f"{config['project']}:{gate['bead']}"
                if kind == "disposition":
                    if signal.get("phase") != gate["phase"] or signal.get("disposition") not in (
                            "accepted", "retired", "external_blocker"):
                        control_gaps.append("control_disposition_not_current")
                        continue
                    if signal["disposition"] == "accepted" and not accepted(gate, config["project"])[0]:
                        control_gaps.append("control_acceptance_receipt_unverified")
                        continue
                    event = Event(event_id, EventKind.DISPOSITION, elapsed, phase=gate["phase"],
                                  disposition=signal["disposition"])
                elif kind == "handoff":
                    bead = signal.get("unit")
                    if not isinstance(bead, str) or not re.fullmatch(
                            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", bead):
                        control_gaps.append("control_handoff_unit_missing")
                        continue
                    if cursor.get("paused") or not any(
                            event.kind is EventKind.ADMISSION and event.unit == bead
                            for event in scheduler.events):
                        control_gaps.append("control_handoff_admission_unverified")
                        continue
                    event = Event(event_id, EventKind.HANDOFF, elapsed, phase=scheduler.phase, unit=bead)
                    target = f"{config['project']}:{bead}"
                elif kind == "park":
                    if not cursor.get("paused"):
                        cursor["paused"] = True
                        cursor["pauseAt"] = elapsed
                    event = Event(event_id, EventKind.PAUSE, elapsed)
                else:
                    if cursor.get("paused"):
                        cursor.pop("pauseAt")
                        cursor["paused"] = False
                    event = Event(event_id, EventKind.RESUME, elapsed)
                was_capture = apply(event, target, capture=control_initialized and not captured
                                    and signal["id"] not in historical_controls,
                                    missed="missed_busy" if captured else "missed_historical")
                captured = captured or was_capture
                if state.get("final"):
                    break
            if state.get("final"):
                break
            phase_index = PHASES.index(scheduler.phase)
            gate = config["gates"][phase_index]
            fingerprint, gate_gap = accepted(gate, config["project"])
            state["gaps"] = sorted(set(observer_gaps + control_gaps + [gate_gap]))
            gate_event = f"gate:{gate['phase']}:{fingerprint}"
            if fingerprint and gate_event not in {event.id for event in scheduler.events}:
                target = f"{config['project']}:{gate['bead']}"
                captured |= apply(Event(gate_event, EventKind.DISPOSITION,
                                        elapsed, phase=gate["phase"], disposition="accepted"),
                                  target, capture=not captured and
                                  fingerprint != prior_gates[gate["phase"]],
                                  missed="missed_busy" if captured else "missed_historical")
            if state.get("final"):
                break
            current, observer_gaps = frame_snapshot(config.get("observerDirectory"))
            current = sorted(current, key=lambda frame: (
                frame.get("observedAt", ""), frame.get("sequence", 0)
            ))
            keys = {(frame.get("epoch"), frame.get("sequence")) for frame in current}
            history = [frame for frame in previous
                       if (frame.get("epoch"), frame.get("sequence")) not in keys] + current
            history.sort(key=lambda frame: (frame.get("observedAt", ""), frame.get("sequence", 0)))
            observed = derive_events(history, project=config["project"],
                                     task_directory=config["taskDirectory"],
                                     project_root=config["projectRoot"],
                                     root_session=config["rootSession"],
                                     admission_caches=current_caches)
            latest = derive_events(current, project=config["project"],
                                   task_directory=config["taskDirectory"],
                                   project_root=config["projectRoot"],
                                   root_session=config["rootSession"],
                                   admission_caches=current_caches)
            state["gaps"] = sorted(set(
                state["gaps"] + observer_gaps + cache_gaps + observed["gaps"] + latest["gaps"]
            ))
            live = ([item for item in latest["events"]
                     if item["kind"] == "admission_cache_record"]
                    + [item for item in observed["events"]
                       if item["kind"] == "first_admission_observed"]
                    + [item for item in latest["events"] if item["kind"] == "nested_overlap"])
            for item in live:
                if item["kind"] in ("first_admission_observed", "admission_cache_record"):
                    event_id = item["eventId"]
                    if event_id in seen_admissions:
                        continue
                    if len(seen_admissions) == MAX_ADMISSION_SEEN:
                        state["gaps"] = sorted(set(state["gaps"] + ["admission_identity_limit"]))
                        continue
                    seen_admissions.add(event_id)
                    state["admissionSeen"] = sorted(seen_admissions)
                    kind, bead = EventKind.ADMISSION, item["bead"]
                elif item["kind"] == "nested_overlap" and item["leaves"]:
                    event_id = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
                    kind, bead = EventKind.NESTED_PAIR, item["leaves"][0]["bead"]
                else:
                    continue
                if (kind is EventKind.NESTED_PAIR
                        and any(event.kind is EventKind.NESTED_PAIR
                                for event in scheduler.events)):
                    continue
                if cursor.get("paused"):
                    state["gaps"] = sorted(set(state["gaps"] + ["live_event_during_pause"]))
                    atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
                    continue
                target = f"{config['project']}:{bead}"
                source_evidence = {
                    **item,
                    "sweepEvidenceGaps": sorted(set(observed["gaps"] + latest["gaps"])),
                }
                was_capture = apply(Event("observer:" + event_id, kind, elapsed,
                                          phase=scheduler.phase, unit=bead,
                                          qualified=kind is EventKind.NESTED_PAIR),
                                    target, capture=not captured, evidence=source_evidence)
                captured = captured or was_capture
            previous = current
            if scheduler.active and elapsed >= cursor["nextTick"]:
                phase_index = PHASES.index(scheduler.phase)
                gate = config["gates"][phase_index]
                apply(Event(f"clock:{elapsed}", EventKind.ADVANCE, elapsed,
                            phase=scheduler.phase),
                      f"{config['project']}:{gate['bead']}", capture=not captured)
            if elapsed - last_saved >= 60:
                atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
                last_saved = elapsed
            if elapsed >= initial + args.duration:
                break
            time.sleep(min(1.0, max(0.0, args.duration - (time.monotonic() - started))))
        state["running"] = False
        atomic_state(args.state_dir, json.dumps(state, sort_keys=True).encode())
        return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("register-startup")
    init.add_argument("--state-dir", type=Path, required=True)
    init.add_argument("--manifest", type=Path, required=True)
    init.add_argument("--expected-sha256", required=True)
    init.add_argument("--budget", type=int, default=25, choices=range(8, 26))
    replay = commands.add_parser("replay")
    replay.add_argument("--state-dir", type=Path, required=True)
    dry = commands.add_parser("dry-run")
    dry.add_argument("--budget", type=int, default=25, choices=range(8, 26))
    inspect = commands.add_parser("inspect-observer")
    inspect.add_argument("--observer-dir", type=Path, required=True)
    inspect.add_argument("--previous-observer-dir", type=Path)
    inspect.add_argument("--project", required=True)
    inspect.add_argument("--task-directory", required=True)
    inspect.add_argument("--project-root", required=True)
    inspect.add_argument("--root-session", required=True)
    run = commands.add_parser("run", help="run from explicit private gate export bindings")
    run.add_argument("--state-dir", type=Path, required=True)
    run.add_argument("--mapping", type=Path, required=True)
    run.add_argument("--expected-sha256", required=True)
    run.add_argument("--budget", type=int, default=25, choices=range(8, 26))
    run.add_argument("--duration", type=int, default=300, choices=range(1, 86401), metavar="1..86400")
    run.add_argument("--confirm-stopped", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "run":
            result = run_sweep(args)
        elif args.command == "register-startup":
            result = startup(args)
        elif args.command == "replay":
            private_directory(args.state_dir)
            result = json.loads(read_private(args.state_dir / "state.json", MAX_DOCUMENT))
        elif args.command == "inspect-observer":
            result = inspect_frames(args)
        else:
            scheduler = SweepScheduler(args.budget)
            checkpoint, = scheduler.append(Event("startup", EventKind.START, 0))
            result = {"slot": checkpoint.slot, "trigger": checkpoint.trigger,
                      "liveAvailable": False, "gaps": ["mapping_not_bound"]}
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(f"work-sweep: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
