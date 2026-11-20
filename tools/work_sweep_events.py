#!/usr/bin/env python3
"""Derive conservative sweep triggers from bounded OmO observer frame history.

Frames are supplied oldest first across parent-scoped producers. This module
does no I/O and does not claim that a frame itself proves its configured root.
"""

import datetime as dt
import hashlib
import json
import os
import re

MAX_FRAMES = 64
MAX_ADMISSION_CACHES = 64
MAX_ROWS = 128
MAX_ADMISSIONS = 1024
MAX_STRING = 512
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")


def _text(value, limit=MAX_STRING):
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def _time(value):
    if not _text(value):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _scope(frame, project, task_directory):
    scope = frame.get("scope")
    return (isinstance(scope, dict) and scope.get("project") == project
            and scope.get("taskDirectory") == task_directory)


def _admissions(frame):
    rows = frame.get("admissions")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        return None
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        task, parent, created = (_text(row.get("task")), _text(row.get("parent")),
                                 _text(row.get("created")))
        bead, attempt = _text(row.get("bead")), _text(row.get("attempt"))
        tool_call = _text(row.get("toolCall"))
        if not all((task, parent, created, bead, attempt, tool_call)):
            continue
        if not SAFE_ID.fullmatch(task):
            continue
        result.append((task, parent, created, bead, attempt, tool_call, row.get("invalid")))
    return result


def _workers(frame):
    rows = frame.get("workers")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        return None
    return [row for row in rows if isinstance(row, dict)]


def admission_event_id(project, task_directory, row):
    """Return a stable ID for one exact guarded admission record."""
    task, parent, created, bead, attempt, tool_call = (
        _text(row.get("task")), _text(row.get("parent")), _text(row.get("created")),
        _text(row.get("bead")), _text(row.get("attempt")), _text(row.get("toolCall")),
    )
    if not all((task, parent, created, bead, attempt, tool_call)) or not SAFE_ID.fullmatch(task):
        return None
    identity = [project, task_directory, task, parent, created, bead, attempt, tool_call]
    digest = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    return "admission:" + digest


def derive_events(frames, *, project, task_directory, project_root,
                  root_session, now=None, max_age_seconds=3, admission_caches=()):
    """Return observed admissions and qualified two-lead overlap events.

    `project_root` and `root_session` are trusted pins supplied by the caller.
    Version-1 frames carry no project root, so the result always reports that
    missing frame-side binding. Frame admission events require an observed
    absent-to-present transition in consecutive frames of one producer epoch.
    Admission caches supply exact continuity records, not event times or liveness.
    """
    if (not _text(project) or not _text(task_directory) or not _text(project_root)
            or not os.path.isabs(project_root) or os.path.normpath(project_root) != project_root
            or not _text(root_session) or len(frames) > MAX_FRAMES):
        raise ValueError("invalid project pins or frame bound")
    current = now or dt.datetime.now(dt.timezone.utc)
    gaps = ["observer_frame_has_no_project_root_identity"]
    usable = []
    admission_count = 0
    cache_rows = []
    events = []
    prior_sequence = {}
    prior_admissions = {}
    all_admissions = {}
    poisoned = set()
    worker_rows = {}
    worker_conflicts = set()
    worker_invalid = set()
    if len(admission_caches) > MAX_ADMISSION_CACHES:
        raise ValueError("admission cache bound exceeded")
    for cache in admission_caches:
        if (not isinstance(cache, dict) or cache.get("version") != 1
                or not _scope(cache, project, task_directory)):
            gaps.append("invalid_or_cross_project_admission_cache")
            continue
        parent, rows = _text(cache.get("parent")), cache.get("admissions")
        if not parent or not isinstance(rows, list) or len(rows) > MAX_ROWS:
            gaps.append("invalid_admission_cache_rows")
            continue
        admission_count += len(rows)
        if admission_count > MAX_ADMISSIONS:
            raise ValueError("replayed admission bound exceeded")
        for row in rows:
            if not isinstance(row, dict) or row.get("parent") != parent:
                gaps.append("invalid_admission_cache_row")
                continue
            task, created = _text(row.get("task")), _text(row.get("created"))
            bead, attempt, tool_call = (_text(row.get("bead")), _text(row.get("attempt")),
                                       _text(row.get("toolCall")))
            invalid = row.get("invalid")
            if (not all((task, created, bead, attempt, tool_call))
                    or not SAFE_ID.fullmatch(task) or type(invalid) is not bool):
                gaps.append("invalid_admission_cache_row")
                continue
            incarnation = (task, parent, created)
            admission = (bead, attempt, tool_call)
            if invalid:
                poisoned.add((incarnation, admission))
            else:
                all_admissions.setdefault(incarnation, set()).add(admission)
                cache_rows.append((task, parent, created, bead, attempt, tool_call))
    for frame in frames:
        if (not isinstance(frame, dict) or frame.get("version") != 1
                or not _scope(frame, project, task_directory)):
            gaps.append("invalid_or_cross_project_frame")
            continue
        observed, expires = _time(frame.get("observedAt")), _time(frame.get("expiresAt"))
        if (observed is None or expires is None or observed > current or expires <= current
                or (current - observed).total_seconds() > max_age_seconds):
            gaps.append("stale_or_invalid_frame")
            continue
        admissions, workers = _admissions(frame), _workers(frame)
        if admissions is None or workers is None:
            gaps.append("invalid_frame_row_bound")
            continue
        admission_count += len(admissions)
        if admission_count > MAX_ADMISSIONS:
            raise ValueError("replayed admission bound exceeded")
        usable.append((frame, admissions, workers))

    for frame, admissions, workers in usable:
        epoch, sequence = _text(frame.get("epoch")), frame.get("sequence")
        if not epoch or not isinstance(sequence, int) or sequence < 1:
            gaps.append("invalid_frame_order")
            continue
        previous = prior_sequence.get(epoch)
        contiguous = previous is not None and sequence == previous + 1
        if previous is not None and not contiguous:
            gaps.append("missed_frame_sequence")
            prior_admissions.pop(epoch, None)
        prior_sequence[epoch] = sequence
        current_keys = set()
        for row in admissions:
            task, parent, created, bead, attempt, tool_call, invalid = row
            incarnation = (task, parent, created)
            admission = (bead, attempt, tool_call)
            if invalid is True:
                poisoned.add((incarnation, admission))
                continue
            if invalid is not False:
                gaps.append("admission_invalidity_unknown")
                continue
            current_keys.add((incarnation, admission))
            all_admissions.setdefault(incarnation, set()).add(admission)
            if contiguous and (incarnation, admission) not in prior_admissions.get(epoch, set()):
                events.append({"kind": "first_admission_observed", "project": project,
                               "bead": bead, "attempt": attempt, "task": task,
                               "parent": parent, "created": created, "toolCall": tool_call,
                               "eventId": admission_event_id(project, task_directory, {
                                   "task": task, "parent": parent, "created": created,
                                   "bead": bead, "attempt": attempt, "toolCall": tool_call,
                               }),
                               "evidence": "consecutive-observer-frames"})
        prior_admissions[epoch] = current_keys
        for worker in workers:
            task, parent, created = (_text(worker.get("task")), _text(worker.get("parent")),
                                     _text(worker.get("created")))
            child, session = _text(worker.get("child")), _text(worker.get("session"))
            identity, source = _text(worker.get("identity")), _text(worker.get("source"))
            worker_at = _time(worker.get("observedAt"))
            key = (task, parent, created)
            if all((task, parent, created)) and worker.get("invalid") is True:
                worker_invalid.add(key)
                gaps.append("invalid_worker_observation")
                continue
            if not all((task, parent, created, child, session, identity, source)):
                continue
            if worker.get("execution") not in ("active", "inactive"):
                continue
            if (worker_at is None or worker_at > current
                    or worker_at > _time(frame.get("observedAt"))
                    or (current - worker_at).total_seconds() > max_age_seconds):
                gaps.append("stale_or_future_worker_observation")
                continue
            signature = (child, session, identity, source, worker.get("execution"), worker_at)
            existing = worker_rows.get(key)
            if existing is None or worker_at > existing[0]:
                worker_rows[key] = (worker_at, signature)
                worker_conflicts.discard(key)
            elif worker_at == existing[0] and signature != existing[1]:
                worker_conflicts.add(key)

    incarnations_by_parent = {}
    for task, parent, created in all_admissions:
        incarnations_by_parent.setdefault((task, parent), set()).add(created)
    ambiguous_incarnations = {
        key for key, created_values in incarnations_by_parent.items()
        if len(created_values) > 1
    }
    if ambiguous_incarnations:
        gaps.append("conflicting_task_incarnations")

    admitted = {}
    for incarnation, owners in all_admissions.items():
        valid = {owner for owner in owners if (incarnation, owner) not in poisoned}
        if (len(valid) == 1 and not any(key[0] == incarnation for key in poisoned)
                and (incarnation[0], incarnation[1]) not in ambiguous_incarnations):
            admitted[incarnation] = next(iter(valid))
        elif valid or owners:
            gaps.append("ambiguous_or_invalid_admission")

    bound = {}
    active = {}
    for key, (observed_at, signature) in worker_rows.items():
        if key in worker_conflicts or key in worker_invalid:
            if key in worker_conflicts:
                gaps.append("contradictory_worker_observations")
            continue
        child, session, identity, source, execution, _ = signature
        if key not in admitted:
            continue
        if child != session:
            gaps.append("worker_session_child_mismatch")
            continue
        bead, attempt, _tool_call = admitted[key]
        row = {"task": key[0], "parent": key[1], "created": key[2],
               "bead": bead, "attempt": attempt, "child": child,
               "session": session, "identity": identity, "source": source,
               "observedAt": observed_at.isoformat()}
        bound[key] = row
        if execution == "active":
            active[key] = row

    leads = {}
    for lead in active.values():
        if lead["parent"] == root_session:
            leads.setdefault(lead["child"], []).append(lead)
    leaves_by_lead = {}
    for lead_session in leads:
        leaves = [worker for worker in active.values() if worker["parent"] == lead_session]
        if len(leads[lead_session]) == 1 and len(leaves) == 1:
            leaves_by_lead[lead_session] = leaves[0]
        elif len(leads[lead_session]) > 1 or len(leaves) > 1:
            gaps.append("ambiguous_root_chain")
    distinct_leaf_sessions = {leaf["session"] for leaf in leaves_by_lead.values()}
    distinct_leaf_instances = {leaf["identity"] for leaf in leaves_by_lead.values()}
    if (len(leaves_by_lead) >= 2
            and len(distinct_leaf_sessions) == len(leaves_by_lead)
            and len(distinct_leaf_instances) == len(leaves_by_lead)):
        lead_workers = [leads[session][0] for session in sorted(leaves_by_lead)]
        events.append({"kind": "nested_overlap", "project": project,
                       "projectRootPin": project_root, "rootSession": root_session,
                       "leads": sorted(leaves_by_lead),
                       "leadWorkers": lead_workers,
                       "leaves": [leaves_by_lead[key] for key in sorted(leaves_by_lead)],
                       "evidence": "two-distinct-admitted-active-leads-and-leaves"})

    reachable_parents = {root_session}
    while True:
        children = {row["child"] for row in bound.values()
                    if row["parent"] in reachable_parents}
        new_parents = children - reachable_parents
        if not new_parents:
            break
        reachable_parents.update(new_parents)
    for task, parent, created, bead, attempt, tool_call in cache_rows:
        incarnation = (task, parent, created)
        admission = (bead, attempt, tool_call)
        if parent in reachable_parents and admitted.get(incarnation) == admission:
            events.append({"kind": "admission_cache_record", "project": project,
                           "bead": bead, "attempt": attempt, "task": task,
                           "parent": parent, "created": created, "toolCall": tool_call,
                           "eventId": admission_event_id(project, task_directory, {
                               "task": task, "parent": parent, "created": created,
                               "bead": bead, "attempt": attempt, "toolCall": tool_call,
                           }),
                           "evidence": "durable-admission-cache"})
    events = [event for event in events
              if event["kind"] not in ("first_admission_observed", "admission_cache_record")
              or (event["parent"] in reachable_parents
                  and admitted.get((event["task"], event["parent"], event["created"]))
                  == (event["bead"], event["attempt"], event["toolCall"]))]
    return {"events": events, "gaps": sorted(set(gaps))}
