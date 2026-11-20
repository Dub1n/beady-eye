import datetime as dt
import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).parents[1] / "tools" / "work_sweep_events.py"
SPEC = importlib.util.spec_from_file_location("work_sweep_events", MODULE)
events = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(events)
NOW = dt.datetime(2026, 11, 19, 12, tzinfo=dt.timezone.utc)
ROOT = "root-session"


def frame(sequence, *, epoch, project="orchard", task_directory="/tasks/orchard",
          admissions=None, workers=None, seconds=0):
    observed = NOW - dt.timedelta(seconds=seconds)
    return {"version": 1, "scope": {"project": project, "taskDirectory": task_directory},
            "epoch": epoch, "sequence": sequence, "observedAt": observed.isoformat(),
            "expiresAt": (observed + dt.timedelta(seconds=3)).isoformat(),
            "admissions": admissions or [], "workers": workers or []}


def admission(task, bead, attempt, parent, *, invalid=False):
    return {"task": task, "bead": bead, "attempt": attempt, "toolCall": "call-" + attempt,
            "parent": parent, "created": "created-" + task, "invalid": invalid}


def worker(task, parent, child, *, observed_at=NOW, execution="active", invalid=False):
    return {"task": task, "parent": parent, "created": "created-" + task,
            "child": child, "session": child, "identity": "instance-" + child,
            "source": "authenticated-host-baseline", "execution": execution,
            "invalid": invalid, "observedAt": observed_at.isoformat()}


def overlap_frames():
    lead_a = admission("task-lead-a", "ORCH-1", "attempt-lead-a", ROOT)
    lead_b = admission("task-lead-b", "ORCH-2", "attempt-lead-b", ROOT)
    leaf_a = admission("task-leaf-a", "ORCH-3", "attempt-leaf-a", "lead-a")
    leaf_b = admission("task-leaf-b", "ORCH-4", "attempt-leaf-b", "lead-b")
    return [
        frame(1, epoch="root-producer"),
        frame(2, epoch="root-producer", admissions=[lead_a, lead_b],
              workers=[worker("task-lead-a", ROOT, "lead-a"),
                       worker("task-lead-b", ROOT, "lead-b")]),
        frame(1, epoch="lead-a-producer", admissions=[leaf_a],
              workers=[worker("task-leaf-a", "lead-a", "leaf-worker-a")]),
        frame(1, epoch="lead-b-producer", admissions=[leaf_b],
              workers=[worker("task-leaf-b", "lead-b", "leaf-worker-b")]),
    ]


class WorkSweepEventsTest(unittest.TestCase):
    def derive(self, frames, **pins):
        return events.derive_events(
            frames, project="orchard", task_directory="/tasks/orchard",
            project_root="/srv/orchard", root_session=ROOT, now=NOW, **pins
        )

    def test_exact_project_and_task_directory_scope_frames(self):
        result = self.derive([frame(1, epoch="other", project="other",
                                    admissions=[admission("task-a", "ORCH-1", "a", ROOT)]),
                              frame(1, epoch="wrong-dir", task_directory="/tasks/other",
                                    admissions=[admission("task-b", "ORCH-2", "b", ROOT)])])
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))
        self.assertIn("invalid_or_cross_project_frame", result["gaps"])

    def test_first_admission_requires_consecutive_absent_then_present(self):
        task = admission("task-a", "ORCH-FULL-IDENTIFIER-17", "attempt-a-full", ROOT)
        result = self.derive([frame(1, epoch="root-producer"),
                              frame(2, epoch="root-producer", admissions=[task])])
        observed = next(event for event in result["events"]
                        if event["kind"] == "first_admission_observed")
        self.assertEqual(observed["bead"], "ORCH-FULL-IDENTIFIER-17")
        self.assertEqual(observed["attempt"], "attempt-a-full")

    def test_replayed_admission_does_not_reemit_first_admission(self):
        task = admission("task-a", "ORCH-1", "attempt-a", ROOT)
        result = self.derive([frame(1, epoch="root-producer", admissions=[task]),
                              frame(2, epoch="root-producer", admissions=[task])])
        self.assertFalse(any(event["kind"] == "first_admission_observed"
                             for event in result["events"]))

    def test_invalid_admission_tombstone_suppresses_later_first_trigger(self):
        invalid = admission("task-a", "ORCH-1", "attempt-a", ROOT, invalid=True)
        valid = admission("task-a", "ORCH-1", "attempt-a", ROOT)
        result = self.derive([frame(1, epoch="root-producer", admissions=[invalid]),
                              frame(2, epoch="root-producer", admissions=[valid])])
        self.assertFalse(any(event["kind"] == "first_admission_observed"
                             for event in result["events"]))

    def test_missed_sequence_does_not_infer_first_admission(self):
        task = admission("task-a", "ORCH-1", "attempt-a", ROOT)
        result = self.derive([frame(1, epoch="root-producer"),
                              frame(3, epoch="root-producer", admissions=[task])])
        self.assertIn("missed_frame_sequence", result["gaps"])
        self.assertFalse(any(event["kind"] == "first_admission_observed"
                             for event in result["events"]))

    def test_two_leads_join_across_parent_scoped_frames(self):
        result = self.derive(overlap_frames())
        overlaps = [event for event in result["events"] if event["kind"] == "nested_overlap"]
        self.assertEqual(len(overlaps), 1)
        self.assertEqual(overlaps[0]["leads"], ["lead-a", "lead-b"])
        self.assertEqual(
            {(lead["task"], lead["identity"]) for lead in overlaps[0]["leadWorkers"]},
            {("task-lead-a", "instance-lead-a"), ("task-lead-b", "instance-lead-b")},
        )
        self.assertEqual({leaf["child"] for leaf in overlaps[0]["leaves"]},
                         {"leaf-worker-a", "leaf-worker-b"})
        self.assertEqual(
            {(leaf["bead"], leaf["attempt"]) for leaf in overlaps[0]["leaves"]},
            {("ORCH-3", "attempt-leaf-a"), ("ORCH-4", "attempt-leaf-b")},
        )

    def test_durable_cache_recovers_scoped_admissions_across_a_frame_gap(self):
        in_scope = [admission(f"task-{index}", f"ORCH-{index}", f"attempt-{index}", ROOT)
                    for index in range(7)]
        out_of_scope = [admission(f"task-other-{index}", f"OTHER-{index}",
                                  f"attempt-other-{index}", "other-root")
                        for index in range(5)]
        frames = [frame(10, epoch="root-producer"),
                  frame(12, epoch="root-producer", admissions=in_scope + out_of_scope)]

        sampled = self.derive(frames)
        caches = [
            {"version": 1, "scope": {"project": "orchard",
                                     "taskDirectory": "/tasks/orchard"},
             "parent": ROOT, "admissions": in_scope},
            {"version": 1, "scope": {"project": "orchard",
                                     "taskDirectory": "/tasks/orchard"},
             "parent": "other-root", "admissions": out_of_scope},
        ]
        reconciled = self.derive(frames, admission_caches=caches)
        recovered = [event for event in reconciled["events"]
                     if event["kind"] == "admission_cache_record"]

        self.assertIn("missed_frame_sequence", sampled["gaps"])
        self.assertFalse(any(event["kind"] == "first_admission_observed"
                             for event in sampled["events"]))
        self.assertEqual(len(in_scope) + len(out_of_scope), 12)
        self.assertEqual(len(out_of_scope), 5)
        self.assertEqual({event["bead"] for event in recovered},
                         {f"ORCH-{index}" for index in range(7)})
        self.assertTrue(all(event["evidence"] == "durable-admission-cache"
                            for event in recovered))
        self.assertFalse(any(event["kind"] == "nested_overlap"
                             for event in reconciled["events"]))

    def test_one_lead_and_one_leaf_is_not_overlap(self):
        frames = overlap_frames()
        result = self.derive(frames[:3])
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_stale_native_worker_timestamp_blocks_overlap(self):
        frames = overlap_frames()
        frames[-1]["workers"][0]["observedAt"] = (NOW - dt.timedelta(seconds=5)).isoformat()
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_invalid_true_admission_blocks_its_worker(self):
        frames = overlap_frames()
        frames[-1]["admissions"][0]["invalid"] = True
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_runtime_child_and_session_must_match(self):
        frames = overlap_frames()
        frames[1]["workers"][0]["session"] = "different-session-label"
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))
        self.assertIn("worker_session_child_mismatch", result["gaps"])

    def test_child_identity_remains_required(self):
        frames = overlap_frames()
        frames[-1]["workers"][0]["child"] = None
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_invalid_worker_row_blocks_overlap(self):
        frames = overlap_frames()
        frames[-1]["workers"][0]["invalid"] = True
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))
        self.assertIn("invalid_worker_observation", result["gaps"])

    def test_same_time_conflicting_child_rows_block_overlap(self):
        frames = overlap_frames()
        conflict = dict(frames[-1]["workers"][0], child="other-child", session="other-child")
        frames[-1]["workers"].append(conflict)
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))
        self.assertIn("contradictory_worker_observations", result["gaps"])

    def test_duplicate_leaf_session_cannot_count_as_two_workers(self):
        frames = overlap_frames()
        frames[-1]["workers"][0]["child"] = "leaf-worker-a"
        frames[-1]["workers"][0]["session"] = "leaf-worker-a"
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_duplicate_leaf_instance_cannot_count_as_two_workers(self):
        frames = overlap_frames()
        frames[-1]["workers"][0]["identity"] = frames[-2]["workers"][0]["identity"]
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_admission_event_is_limited_to_pinned_root_chain(self):
        unrelated = admission("task-unrelated", "OTHER-1", "attempt-unrelated", "other-root")
        frames = overlap_frames() + [
            frame(1, epoch="other-root-producer"),
            frame(2, epoch="other-root-producer", admissions=[unrelated]),
        ]
        result = self.derive(frames)
        self.assertFalse(any(event.get("bead") == "OTHER-1" for event in result["events"]))

    def test_recreated_task_id_cannot_join_old_and_new_incarnations(self):
        frames = overlap_frames()
        old = dict(frames[-1]["admissions"][0], created="created-old")
        frames[-1]["admissions"].append(old)
        result = self.derive(frames)
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))
        self.assertIn("conflicting_task_incarnations", result["gaps"])

    def test_root_session_pin_must_match_lead_admission_parent(self):
        result = events.derive_events(
            overlap_frames(), project="orchard", task_directory="/tasks/orchard",
            project_root="/srv/orchard", root_session="different-root", now=NOW
        )
        self.assertFalse(any(event["kind"] == "nested_overlap" for event in result["events"]))

    def test_explicit_project_root_pin_is_required(self):
        with self.assertRaises(ValueError):
            events.derive_events(overlap_frames(), project="orchard",
                                 task_directory="/tasks/orchard", project_root="orchard",
                                 root_session=ROOT, now=NOW)

    def test_frame_root_binding_gap_stays_visible(self):
        result = self.derive(overlap_frames())
        self.assertIn("observer_frame_has_no_project_root_identity", result["gaps"])

    def test_admission_replay_bound_is_enforced(self):
        frames = [frame(i + 1, epoch="root-producer",
                        admissions=[admission(f"task-{i}-{j}", f"ORCH-{i}-{j}",
                                              f"a-{i}-{j}", ROOT)
                                    for j in range(128)])
                  for i in range(9)]
        with self.assertRaises(ValueError):
            events.derive_events(frames, project="orchard", task_directory="/tasks/orchard",
                                 project_root="/srv/orchard", root_session=ROOT,
                                 now=NOW, max_age_seconds=3)


if __name__ == "__main__":
    unittest.main()
