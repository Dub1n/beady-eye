"""Deterministic, invented examples for the work-sweep scheduler."""
# noqa: SIZE_OK - keep deterministic scheduler state-machine regressions together.

from __future__ import annotations

import unittest

from tools.work_sweep_schedule import (
    Event,
    EventKind,
    ScheduleInputError,
    SweepScheduler,
)


def event(
    event_id: str,
    kind: EventKind,
    at: int,
    *,
    phase: str | None = None,
    unit: str | None = None,
    disposition: str | None = None,
    qualified: bool = False,
) -> Event:
    return Event(event_id, kind, at, phase, unit, disposition, qualified)


class WorkSweepScheduleTests(unittest.TestCase):
    def test_startup_counts_once_and_duplicates_do_not_emit(self) -> None:
        scheduler = SweepScheduler()
        startup = event("start", EventKind.START, 0)

        self.assertEqual(scheduler.append(startup)[0].trigger, "startup")
        self.assertEqual(scheduler.append(startup), ())
        self.assertEqual(scheduler.append(event("start-again", EventKind.START, 1)), ())
        self.assertEqual(len(scheduler.checkpoints), 1)

    def test_pause_and_resume_preserve_active_time_without_catchup(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 10))
        scheduler.append(event("partial", EventKind.ADVANCE, 210))
        scheduler.append(event("pause", EventKind.PAUSE, 210))
        scheduler.append(event("resume", EventKind.RESUME, 2_000))
        self.assertEqual(scheduler.append(event("not-yet", EventKind.ADVANCE, 2_099)), ())
        checkpoints = scheduler.append(event("tick", EventKind.ADVANCE, 2_100))

        self.assertEqual([(item.trigger, item.at) for item in checkpoints], [("timer", 2_100)])

    def test_timer_gap_counts_only_reserved_missed_slots_without_catchup(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 100, phase="G0", disposition="accepted"
        ))
        scheduler.append(event(
            "close-G1", EventKind.DISPOSITION, 200, phase="G1", disposition="accepted"
        ))
        checkpoints = scheduler.append(event("late-clock", EventKind.ADVANCE, 1_700))

        self.assertEqual([item.trigger for item in checkpoints], ["timer"])
        self.assertEqual(scheduler.missed_slots, 3)
        self.assertEqual(checkpoints[0].slot, 7)

    def test_exhausted_phase_ticks_remain_unused(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event("first-tick", EventKind.ADVANCE, 300))
        scheduler.append(event("late-tick", EventKind.ADVANCE, 3_000))

        self.assertEqual(scheduler.missed_slots, 0)
        self.assertEqual(scheduler.unused_slots, 23)

    def test_new_gate_starts_a_fresh_active_tick(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 250, phase="G0", disposition="accepted"
        ))
        self.assertEqual(scheduler.append(event("before-new-tick", EventKind.ADVANCE, 549)), ())
        checkpoints = scheduler.append(event("new-gate-tick", EventKind.ADVANCE, 550))

        self.assertEqual([(item.phase, item.at) for item in checkpoints], [("G1", 550)])

    def test_qualified_live_events_replace_routine_ticks_once(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        actual = []
        cases = (
            ("admit", EventKind.ADMISSION, 20, "unit-a", False),
            ("pair-unqualified", EventKind.NESTED_PAIR, 30, None, False),
            ("close-G0", EventKind.DISPOSITION, 35, None, False),
            ("pair", EventKind.NESTED_PAIR, 40, None, True),
            ("wrong-handoff", EventKind.HANDOFF, 50, "unit-b", False),
            ("handoff", EventKind.HANDOFF, 60, "unit-a", False),
            ("handoff-again", EventKind.HANDOFF, 70, "unit-a", False),
        )
        for event_id, kind, at, unit, qualified in cases:
            actual.extend(
                checkpoint.trigger
                for checkpoint in scheduler.append(
                    event(
                        event_id, kind, at, unit=unit, qualified=qualified,
                        phase="G0" if kind is EventKind.DISPOSITION else None,
                        disposition="accepted" if kind is EventKind.DISPOSITION else None,
                    )
                )
            )

        self.assertEqual(
            actual,
            ["admission", "disposition:accepted", "nested_pair", "handoff"],
        )

    def test_dispositions_follow_gate_order_and_final_is_once(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        self.assertEqual(
            scheduler.append(event(
                "skip-g1", EventKind.DISPOSITION, 1, phase="G1", disposition="accepted"
            )),
            (),
        )
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5"), 1):
            scheduler.append(event(
                f"close-{phase}", EventKind.DISPOSITION, index + 1,
                phase=phase, disposition="accepted",
            ))
        final = scheduler.append(event(
            "final", EventKind.DISPOSITION, 9, phase="FINAL", disposition="retired"
        ))
        duplicate_final = scheduler.append(event(
            "final-copy", EventKind.DISPOSITION, 10, phase="FINAL", disposition="accepted"
        ))

        self.assertEqual([item.phase for item in scheduler.checkpoints if item.trigger.startswith("disposition:")],
                         ["G0", "G1", "G2", "G3", "G4", "G5"])
        self.assertEqual([(item.phase, item.trigger) for item in final], [("FINAL", "final:retired")])
        self.assertEqual(duplicate_final, ())
        self.assertEqual(
            scheduler.dispositions,
            tuple((phase, "accepted") for phase in ("G0", "G1", "G2", "G3", "G4", "G5"))
            + (("FINAL", "retired"),),
        )

    def test_one_unused_slot_carries_forward_but_final_slot_is_reserved(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 1, phase="G0",
            disposition="accepted",
        ))
        carried = []
        for event_id, kind, at, unit, qualified in (
            ("admit", EventKind.ADMISSION, 2, "unit-a", False),
            ("pair", EventKind.NESTED_PAIR, 3, None, True),
            ("handoff", EventKind.HANDOFF, 4, "unit-a", False),
        ):
            carried.extend(scheduler.append(event(
                event_id, kind, at, unit=unit, qualified=qualified
            )))
        scheduler.append(event(
            "close-G1", EventKind.DISPOSITION, 5, phase="G1",
            disposition="accepted",
        ))
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5"), 1):
            if phase in ("G0", "G1"):
                continue
            scheduler.append(event(
                f"close-{phase}", EventKind.DISPOSITION, index + 5,
                phase=phase, disposition="accepted",
            ))
        final = scheduler.append(event(
            "final", EventKind.DISPOSITION, 12, phase="FINAL", disposition="accepted"
        ))

        self.assertEqual([item.trigger for item in carried], ["admission", "nested_pair", "handoff"])
        self.assertEqual([(item.phase, item.trigger) for item in final], [("FINAL", "final:accepted")])
        self.assertEqual(scheduler.unused_slots, 14)
        self.assertEqual(scheduler.budget, 25)

    def test_external_blocker_holds_phase_across_replay_until_resolution(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 1, phase="G0", disposition="accepted",
        ))
        scheduler.append(event(
            "block-G1", EventKind.DISPOSITION, 2, phase="G1",
            disposition="external_blocker",
        ))
        held = scheduler.append(event(
            "blocked-clock", EventKind.ADVANCE, 302, phase="G1",
        ))
        self.assertEqual(held, ())
        self.assertFalse(scheduler.active)
        self.assertFalse(scheduler.parked)
        scheduler.append(event("park", EventKind.PAUSE, 303))
        scheduler.append(event("resume", EventKind.RESUME, 30_000))

        blocked = SweepScheduler.from_json(scheduler.to_json())
        self.assertEqual(blocked.phase, "G1")
        routine = blocked.append(event(
            "G1-timer", EventKind.ADVANCE, 30_300, phase="G1",
        ))
        self.assertEqual([(item.slot, item.phase) for item in routine], [(4, "G1")])
        self.assertEqual(blocked.phase, "G1")

        resolved = blocked.append(event(
            "accept-G1", EventKind.DISPOSITION, 30_301, phase="G1",
            disposition="accepted",
        ))
        progress = blocked.append(event(
            "admit-G2", EventKind.ADMISSION, 30_302, phase="G2", unit="unit-a",
        ))

        self.assertEqual(resolved, ())
        self.assertEqual(blocked.phase, "G2")
        self.assertEqual([(item.slot, item.phase, item.trigger) for item in progress],
                         [(5, "G2", "admission")])
        self.assertEqual(
            [item.trigger for item in blocked.checkpoints if item.phase == "G1"
             and item.trigger.startswith("disposition:")],
            ["disposition:external_blocker"],
        )
        self.assertEqual(SweepScheduler.from_json(blocked.to_json()).phase, "G2")

    def test_retirement_resolves_blocker_without_a_second_reserved_slot(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 1, phase="G0", disposition="accepted",
        ))
        scheduler.append(event(
            "block-G1", EventKind.DISPOSITION, 2, phase="G1",
            disposition="external_blocker",
        ))

        self.assertEqual(scheduler.append(event(
            "retire-G1", EventKind.DISPOSITION, 3, phase="G1", disposition="retired",
        )), ())

        self.assertEqual(scheduler.phase, "G2")
        self.assertEqual(
            [item.trigger for item in scheduler.checkpoints if item.phase == "G1"],
            ["disposition:external_blocker"],
        )
        self.assertEqual(scheduler.dispositions[-2:],
                         (("G1", "external_blocker"), ("G1", "retired")))

        retired = SweepScheduler()
        retired.append(event("start", EventKind.START, 0))
        retired.append(event(
            "close-G0", EventKind.DISPOSITION, 1, phase="G0", disposition="accepted",
        ))
        retirement = retired.append(event(
            "retire-G1", EventKind.DISPOSITION, 2, phase="G1", disposition="retired",
        ))

        self.assertEqual([(item.slot, item.phase, item.trigger) for item in retirement],
                         [(3, "G1", "disposition:retired")])
        self.assertEqual(retired.phase, "G2")

    def test_legacy_unphased_activity_after_blocker_fails_closed(self) -> None:
        serialized = (
            '{"budget":25,"events":['
            '{"id":"start","kind":"start","at":0,"phase":null,"unit":null,'
            '"disposition":null,"qualified":false},'
            '{"id":"close-G0","kind":"disposition","at":1,"phase":"G0","unit":null,'
            '"disposition":"accepted","qualified":false},'
            '{"id":"block-G1","kind":"disposition","at":2,"phase":"G1","unit":null,'
            '"disposition":"external_blocker","qualified":false},'
            '{"id":"legacy-clock","kind":"advance","at":302,"phase":null,"unit":null,'
            '"disposition":null,"qualified":false}]}'
        )

        with self.assertRaisesRegex(ScheduleInputError, "ambiguous activity after external blocker"):
            SweepScheduler.from_json(serialized)

    def test_unused_carry_expires_after_the_immediate_next_gate(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event(
            "close-G0", EventKind.DISPOSITION, 1, phase="G0",
            disposition="accepted",
        ))
        scheduler.append(event("admit", EventKind.ADMISSION, 2, unit="unit-a"))
        scheduler.append(event(
            "pair", EventKind.NESTED_PAIR, 3, qualified=True
        ))
        scheduler.append(event(
            "close-G1", EventKind.DISPOSITION, 4, phase="G1",
            disposition="accepted",
        ))
        scheduler.append(event("first-G2-tick", EventKind.ADVANCE, 604))
        scheduler.append(event("second-G2-tick", EventKind.ADVANCE, 904))
        handoff = scheduler.append(event(
            "handoff", EventKind.HANDOFF, 905, unit="unit-a"
        ))

        self.assertEqual(handoff, ())
        self.assertEqual(scheduler.missed_slots, 1)

    def test_late_events_are_persisted_but_do_not_rewind_replay(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 10))
        scheduler.append(event("later", EventKind.ADVANCE, 20))
        late = event("late", EventKind.ADMISSION, 15, unit="unit-a")

        self.assertEqual(scheduler.append(late), ())
        restored = SweepScheduler.from_json(scheduler.to_json())

        self.assertEqual(restored.to_json(), scheduler.to_json())
        self.assertEqual(restored.checkpoints, scheduler.checkpoints)
        self.assertEqual(len(restored.events), 3)
        self.assertEqual(restored.append(late), ())

    def test_invalid_events_do_not_poison_persisted_replay(self) -> None:
        scheduler = SweepScheduler()
        scheduler.append(event("start", EventKind.START, 0))
        with self.assertRaises(ScheduleInputError):
            scheduler.append(event(
                "recoverable-id", EventKind.DISPOSITION, 1,
                phase="unknown", disposition="accepted",
            ))
        accepted = event(
            "recoverable-id", EventKind.DISPOSITION, 1,
            phase="G0", disposition="accepted",
        )

        scheduler.append(accepted)
        restored = SweepScheduler.from_json(scheduler.to_json())

        self.assertEqual(restored.to_json(), scheduler.to_json())
        self.assertEqual(restored.dispositions, (("G0", "accepted"),))

    def test_selectable_budget_caps_emissions(self) -> None:
        scheduler = SweepScheduler(budget=8)
        scheduler.append(event("start", EventKind.START, 0))
        scheduler.append(event("admission", EventKind.ADMISSION, 1, unit="unit-a"))
        for index, phase in enumerate(("G0", "G1", "G2", "G3", "G4", "G5"), 1):
            scheduler.append(event(
                f"close-{phase}", EventKind.DISPOSITION, index + 1,
                phase=phase, disposition="accepted",
            ))
        scheduler.append(event(
            "final", EventKind.DISPOSITION, 8, phase="FINAL", disposition="accepted"
        ))

        self.assertEqual(len(scheduler.checkpoints), 8)
        self.assertNotIn("admission", [item.trigger for item in scheduler.checkpoints])
        self.assertEqual(scheduler.missed_slots, 0)
        self.assertEqual(scheduler.unused_slots, 0)


if __name__ == "__main__":
    unittest.main()
