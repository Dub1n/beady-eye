#!/usr/bin/env python3
"""Inspect exported Beads receipts without invoking commands or writing data.

Supply --project for raw bd list --json rows, which have no project field.
Native task observations cannot establish execution, attribution or acceptance.
"""
import argparse
import json
import os
import re
import stat
import sys

MAX_STDIN = 4 * 1024 * 1024
MAX_TASKS = 1000
MAX_RECEIPTS = 64
MAX_TOTAL_RECEIPTS = 1000
MAX_TASK_BYTES = 128 * 1024
SAFE_TASK = re.compile(r"^[A-Za-z0-9_-]{1,160}$")


def identity(value):
    return value if isinstance(value, str) and 0 < len(value) <= 160 else None


def native_record(directory, task_id):
    if not directory:
        return None, "unavailable"
    if not identity(task_id) or not SAFE_TASK.fullmatch(task_id):
        return None, "invalid_task_id"
    directory_fd = fd = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fd = os.open(task_id + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory_fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TASK_BYTES:
            return None, "invalid"
        # One bounded read loop, even if a writer grows the opened file.
        raw = bytearray()
        while len(raw) <= MAX_TASK_BYTES:
            chunk = os.read(fd, min(8192, MAX_TASK_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > MAX_TASK_BYTES:
            return None, "invalid"
        value = json.loads(raw)
        if not isinstance(value, dict):
            return None, "invalid"
        return value, "observed"
    except FileNotFoundError:
        return None, "unavailable"
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None, "invalid"
    finally:
        if fd is not None:
            os.close(fd)
        if directory_fd is not None:
            os.close(directory_fd)


def _diagnose_single(payload, task_dir=None, project=None):
    if not identity(project):
        raise ValueError("a bounded nonempty project is required")
    issues = payload.get("issues") if isinstance(payload, dict) else payload
    if not isinstance(issues, list) or len(issues) > MAX_TASKS:
        raise ValueError("input must contain at most 1000 issue objects")
    output = []
    for issue in issues:
        if not isinstance(issue, dict) or not identity(issue.get("id")):
            raise ValueError("every issue needs a bounded full id string")
        if "project" in issue and issue["project"] != project:
            raise ValueError("issue project disagrees with supplied project")
        bead_id = issue["id"]
        metadata = issue.get("metadata", {})
        metadata = metadata if isinstance(metadata, dict) else {}
        work = metadata.get("qrclipWork", {})
        work = work if isinstance(work, dict) else {}
        attempt = work.get("attempt")
        dispatch = metadata.get("qrclipDispatch")
        status = issue.get("status")
        status = status if status in ("open", "in_progress", "hooked", "blocked", "closed", "done", "deferred") else "unknown"
        lifecycle = ("historical" if status in ("closed", "done") else
                     "active" if status == "in_progress" else
                     "transitional" if status in ("hooked", "blocked") else "inactive")
        reasons = []
        conflict = stale = False
        observed_child = receipt_child = None
        native_state = "not_requested"
        mode = attempt_id = None
        classification = "partial_receipt" if dispatch is not None else "no_work_contract"
        if attempt is not None:
            if not isinstance(attempt, dict):
                classification = "partial_attempt"
            else:
                mode = attempt.get("mode")
                mode = mode if mode in ("direct", "delegate") else None
                attempt_id = identity(attempt.get("id"))
                coordinator = identity(attempt.get("coordinator"))
                if not mode or not attempt_id:
                    classification = "partial_attempt"
                elif dispatch is None:
                    classification = ("direct_attempt" if mode == "direct" else
                                      "missing_receipt" if lifecycle == "active" else
                                      "historical_without_receipt" if lifecycle == "historical" else
                                      "transitional_without_receipt" if lifecycle == "transitional" else "inactive_without_receipt")
                elif not isinstance(dispatch, dict):
                    classification = "partial_receipt"
                elif not identity(dispatch.get("attemptId")):
                    classification = "partial_receipt"
                elif dispatch["attemptId"] != attempt_id:
                    stale = True
                    classification = "historical_receipt"
                elif mode == "direct":
                    conflict = True
                    reasons.append("direct_attempt_has_dispatch_receipt")
                else:
                    receipt_child = identity(dispatch.get("childSession"))
                    task_id = identity(dispatch.get("taskId"))
                    classification = "receipt_observed" if task_id and receipt_child else "partial_receipt"
                    record, native_state = native_record(task_dir, dispatch.get("taskId"))
                    if record is not None:
                        for key, expected in (("task_id", task_id), ("project", project),
                                              ("bead_id", bead_id), ("attempt_id", attempt_id),
                                              ("parent_session_id", coordinator), ("coordinator", coordinator)):
                            if key in record and identity(record[key]) is None:
                                reasons.append("invalid_native_" + key)
                                native_state = "invalid"
                            elif key in record and expected is not None and record[key] != expected:
                                conflict = True
                                reasons.append("native_" + key + "_mismatch")
                        child = identity(record.get("child_session_id"))
                        if receipt_child and child and receipt_child != child:
                            conflict = True
                            reasons.append("native_child_session_mismatch")
                        if not identity(record.get("task_id")):
                            native_state = "invalid"
                        elif not coordinator or not identity(record.get("parent_session_id")):
                            reasons.append("independent_coordinator_binding_missing")
                        elif native_state == "observed" and not conflict:
                            observed_child = child
                            if child:
                                reasons.append("unverified_task_record_child_observation")
                        if "child_session_id" in record and child is None:
                            native_state = "invalid"
                        if conflict:
                            native_state = "identity_mismatch"
                        elif native_state == "invalid":
                            observed_child = None
                    if dispatch.get("childSession") is not None and receipt_child is None:
                        reasons.append("invalid_receipt_child_session")
                        classification = "partial_receipt"
        if conflict:
            classification = "conflict"
        output.append({"project": project, "id": bead_id, "status": status,
                       "mode": mode, "currentAttempt": attempt_id, "lifecycle": lifecycle,
                       "classification": classification, "staleReceipt": stale,
                       "conflict": conflict, "receiptChildSession": receipt_child,
                       "unverifiedTaskRecordChildSession": observed_child,
                       "nativeRecord": native_state, "reasons": reasons})
    return {"records": output, "claims": {"liveness": False, "execution": False,
                                           "attribution": False, "acceptance": False}}


def diagnose(payload, task_dir=None, project=None):
    """Audit flat worker receipts independently; never flatten nested collections.

    Legacy scalar fields remain meaningful for a single receipt. Collections use
    receipts for worker details and a conservative aggregate classification.
    """
    # Validate the issue envelope before any optional native record reads.
    baseline = _diagnose_single(payload, project=project)
    issues = payload.get("issues") if isinstance(payload, dict) else payload
    total = 0
    for issue, row in zip(issues, baseline["records"]):
        metadata = issue.get("metadata")
        dispatch = metadata.get("qrclipDispatch") if isinstance(metadata, dict) else None
        collection = isinstance(dispatch, list) or (isinstance(dispatch, dict) and "tasks" in dispatch)
        if not collection:
            if dispatch is not None:
                if total >= MAX_TOTAL_RECEIPTS:
                    row.update(classification="ambiguous_receipts", nativeRecord="not_requested",
                               reasons=["receipt_limit_exceeded"])
                    continue
                total += 1
            single = _diagnose_single([issue], task_dir, project)["records"][0]
            row.update(single)
            continue
        entries = dispatch if isinstance(dispatch, list) else dispatch["tasks"]
        reasons = []
        if isinstance(dispatch, dict) and any(key in dispatch for key in ("taskId", "attemptId", "childSession")):
            reasons.append("mixed_receipt_and_tasks")
        if not isinstance(entries, list):
            reasons.append("invalid_receipt_collection")
        elif len(entries) > MAX_RECEIPTS or total + len(entries) > MAX_TOTAL_RECEIPTS:
            reasons.append("receipt_limit_exceeded")
        else:
            total += len(entries)
        workers = []
        if not reasons and isinstance(entries, list):
            counts = {}
            for entry in entries:
                task_id = identity(entry.get("taskId")) if isinstance(entry, dict) else None
                if task_id:
                    counts[task_id] = counts.get(task_id, 0) + 1
            for index, entry in enumerate(entries):
                malformed = not isinstance(entry, dict) or "tasks" in entry
                invalid_fields = isinstance(entry, dict) and (
                    not identity(entry.get("attemptId")) or not identity(entry.get("taskId")) or
                    (entry.get("childSession") is not None and not identity(entry["childSession"])))
                worker_issue = dict(issue, metadata=dict(metadata, qrclipDispatch={} if malformed else entry))
                worker = _diagnose_single([worker_issue], None if malformed or invalid_fields else task_dir, project)["records"][0]
                worker = {key: value for key, value in worker.items()
                          if key not in ("project", "id", "status", "mode", "currentAttempt", "lifecycle")}
                worker["index"] = index
                worker["taskId"] = identity(entry.get("taskId")) if isinstance(entry, dict) else None
                worker["ambiguous"] = malformed or invalid_fields or counts.get(worker["taskId"], 0) > 1
                if malformed:
                    worker["reasons"].append("unsupported_nested_or_malformed_receipt")
                if invalid_fields:
                    worker["reasons"].append("invalid_receipt_fields")
                if counts.get(worker["taskId"], 0) > 1:
                    worker["reasons"].append("duplicate_task_id")
                    worker["unverifiedTaskRecordChildSession"] = None
                workers.append(worker)
        row.update(receipts=workers, ambiguous=bool(reasons) or any(w["ambiguous"] for w in workers),
                   reasons=reasons, conflict=any(w["conflict"] for w in workers),
                   staleReceipt=any(w["staleReceipt"] for w in workers),
                   receiptChildSession=None, unverifiedTaskRecordChildSession=None,
                   nativeRecord="per_receipt")
        if row["ambiguous"]:
            row["classification"] = "ambiguous_receipts"
        elif row["conflict"]:
            row["classification"] = "conflict"
        elif not workers:
            row["classification"] = "partial_receipt"
        elif len(workers) == 1:
            row["classification"] = workers[0]["classification"]
        else:
            row["classification"] = "multiple_receipts"
    return baseline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="project identity for the exported bd list rows")
    parser.add_argument("--task-dir", help="optional directory of native <taskId>.json records")
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(MAX_STDIN + 1)
    if len(raw) > MAX_STDIN:
        parser.error("stdin exceeds 4 MiB")
    try:
        result = diagnose(json.loads(raw), args.task_dir, args.project)
    except (UnicodeError, ValueError, RecursionError) as error:
        parser.error(str(error))
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
