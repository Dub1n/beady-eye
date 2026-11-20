# noqa: SIZE_OK — replayable scheduler state machine kept in one authorized module
"""Deterministic event-fed checkpoints for one bounded work sweep.

Programmatic interface: construct ``SweepScheduler``, feed ``Event`` values to
``append``, and persist ``to_json()``. Restore with ``from_json()``; replay
returns the same checkpoints without re-emitting already recorded events.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import json
from typing import Final

PHASES: Final = ("G0", "G1", "G2", "G3", "G4", "G5", "FINAL")
PHASE_BUDGETS: Final = (3, 3, 4, 4, 3, 7, 1)
DISPOSITION_PHASES: Final = frozenset(PHASES[:-1])
TICK_SECONDS: Final = 300
DEFAULT_BUDGET: Final = 25


class EventKind(StrEnum):
    START = "start"
    ADVANCE = "advance"
    PAUSE = "pause"
    RESUME = "resume"
    DISPOSITION = "disposition"
    ADMISSION = "admission"
    NESTED_PAIR = "nested_pair"
    HANDOFF = "handoff"


class ScheduleInputError(ValueError):
    """Invalid scheduler configuration or event input."""

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class Event:
    """One timestamped input from the existing sweep workflow records."""

    id: str
    kind: EventKind
    at: int
    phase: str | None = None
    unit: str | None = None
    disposition: str | None = None
    qualified: bool = False


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """One scheduled observation."""

    slot: int
    phase: str
    trigger: str
    at: int
    unit: str | None = None


def _phase_index(phase: str) -> int:
    try:
        return PHASES.index(phase)
    except ValueError as error:
        raise ScheduleInputError(f"unknown sweep phase: {phase}") from error


class SweepScheduler:
    """Replayable scheduler; event history is its durable source of truth."""

    def __init__(self, budget: int = DEFAULT_BUDGET) -> None:
        if not len(PHASES) + 1 <= budget <= sum(PHASE_BUDGETS):
            raise ScheduleInputError(
                f"budget must be from {len(PHASES) + 1} to {sum(PHASE_BUDGETS)}"
            )
        self._budget = budget
        self._events: list[Event] = []
        self._checkpoints: list[Checkpoint] = []
        self._dispositions: list[tuple[str, str]] = []
        self._ids: set[str] = set()
        self._phase = "G0"
        self._active = False
        self._parked = False
        self._started = False
        self._finalized = False
        self._last_at: int | None = None
        self._active_elapsed = 0
        self._next_tick = TICK_SECONDS
        self._admitted_unit: str | None = None
        self._blocked_phase: str | None = None
        self._routine_used = {phase: 0 for phase in PHASES}
        self._reserved_used = {phase: 0 for phase in PHASES}
        self._event_used: set[str] = set()
        self._carry = 0
        self._missed = 0

    @property
    def missed_slots(self) -> int:
        return self._missed

    @property
    def budget(self) -> int:
        return self._budget

    @property
    def phase(self) -> str:
        return self._phase

    @property
    def active(self) -> bool:
        return self._active

    @property
    def parked(self) -> bool:
        return self._parked

    @property
    def active_elapsed(self) -> int:
        return self._active_elapsed

    @property
    def next_tick(self) -> int:
        return self._next_tick

    @property
    def last_at(self) -> int | None:
        return self._last_at

    @property
    def events(self) -> tuple[Event, ...]:
        return tuple(self._events)

    @property
    def checkpoints(self) -> tuple[Checkpoint, ...]:
        return tuple(self._checkpoints)

    @property
    def dispositions(self) -> tuple[tuple[str, str], ...]:
        return tuple(self._dispositions)

    @property
    def unused_slots(self) -> int:
        return self.budget - len(self._checkpoints) - self._missed

    def append(self, event: Event) -> tuple[Checkpoint, ...]:
        """Apply a unique event; late timestamps are retained but not rewound."""
        if (
            not isinstance(event, Event)
            or not isinstance(event.id, str)
            or not event.id
            or not isinstance(event.kind, EventKind)
            or type(event.at) is not int
            or event.at < 0
            or (event.phase is not None and not isinstance(event.phase, str))
            or (event.unit is not None and not isinstance(event.unit, str))
            or (event.disposition is not None and not isinstance(event.disposition, str))
            or type(event.qualified) is not bool
        ):
            raise ScheduleInputError("event fields have invalid types or values")
        if event.id in self._ids:
            return ()
        if event.kind is EventKind.DISPOSITION:
            if (
                event.phase is None
                or event.disposition not in ("accepted", "retired", "external_blocker")
            ):
                raise ScheduleInputError(
                    "disposition needs a phase and ordered disposition"
                )
            _phase_index(event.phase)
        if self._last_at is not None and event.at < self._last_at:
            self._events.append(event)
            self._ids.add(event.id)
            return ()
        if self._blocked_phase is not None:
            if (
                event.kind in (
                    EventKind.ADVANCE,
                    EventKind.ADMISSION,
                    EventKind.NESTED_PAIR,
                    EventKind.HANDOFF,
                )
                and event.phase != self._blocked_phase
            ):
                raise ScheduleInputError(
                    "ambiguous activity after external blocker must name its phase"
                )
            if (
                event.kind is EventKind.DISPOSITION
                and event.phase is not None
                and _phase_index(event.phase) > _phase_index(self._blocked_phase)
            ):
                raise ScheduleInputError(
                    "later phase disposition follows unresolved external blocker"
                )
        self._events.append(event)
        self._ids.add(event.id)
        before = len(self._checkpoints)
        if self._started and self._active:
            elapsed = event.at - self._last_at if self._last_at is not None else 0
            self._active_elapsed += elapsed
        self._last_at = event.at

        match event.kind:
            case EventKind.START:
                if not self._started:
                    self._started = True
                    self._phase = "G0"
                    self._schedule("startup", event.at)
                    self._routine_used["G0"] = 1
                    self._active = True
                    self._next_tick = self._active_elapsed + TICK_SECONDS
            case EventKind.ADVANCE:
                self._on_advance(event.at)
            case EventKind.PAUSE:
                self._parked = True
                self._active = False
            case EventKind.RESUME:
                self._parked = False
                if self._started and not self._finalized:
                    self._active = True
            case EventKind.DISPOSITION:
                self._on_disposition(event)
            case EventKind.ADMISSION | EventKind.NESTED_PAIR | EventKind.HANDOFF:
                self._on_live_event(event)
            case unreachable:
                from typing import assert_never

                assert_never(unreachable)
        return tuple(self._checkpoints[before:])

    def _on_advance(self, at: int) -> None:
        if not self._started or not self._active:
            return
        due = (self._active_elapsed - self._next_tick) // TICK_SECONDS + 1
        if due <= 0:
            return
        available = self._routine_slots_available()
        if available == 0:
            return
        missed = min(due - 1, available - 1)
        self._consume_missed_routine(missed)
        self._consume_routine(at, "timer", None)
        self._next_tick = self._active_elapsed + TICK_SECONDS

    def _on_disposition(self, event: Event) -> None:
        if not self._started:
            return
        phase = event.phase
        disposition = event.disposition
        if phase is None or disposition is None:
            raise ScheduleInputError("disposition fields are required")
        index = _phase_index(phase)
        if phase == "FINAL":
            if self._phase == "FINAL" and not self._finalized:
                self._phase = "FINAL"
                self._schedule(f"final:{disposition}", event.at)
                self._dispositions.append((phase, disposition))
                self._finalized = True
                self._active = False
            return
        if phase != self._phase:
            return
        if phase not in DISPOSITION_PHASES:
            return
        if disposition == "external_blocker":
            if not self._reserved_used[phase]:
                self._schedule(f"disposition:{disposition}", event.at)
                self._reserved_used[phase] = 1
                self._dispositions.append((phase, disposition))
                self._blocked_phase = phase
                self._active = False
                self._next_tick = self._active_elapsed + TICK_SECONDS
            return
        if not self._reserved_used[phase]:
            self._schedule(f"disposition:{disposition}", event.at)
            self._reserved_used[phase] = 1
        self._dispositions.append((phase, disposition))
        self._blocked_phase = None
        self._phase = PHASES[index + 1]
        self._active = not self._parked
        self._carry = min(1, self._unused_routine(phase))
        self._next_tick = self._active_elapsed + TICK_SECONDS

    def _on_live_event(self, event: Event) -> None:
        trigger = event.kind.value
        key = event.kind.value
        if (
            not self._active
            or self._finalized
            or key in self._event_used
            or (event.kind is EventKind.NESTED_PAIR and not event.qualified)
            or (event.phase is not None and event.phase != self._phase)
        ):
            return
        if event.kind is EventKind.ADMISSION and not event.unit:
            return
        if event.kind is EventKind.HANDOFF and (
            not event.unit or event.unit != self._admitted_unit
        ):
            return
        self._event_used.add(key)
        if event.kind is EventKind.ADMISSION:
            self._admitted_unit = event.unit
        self._consume_routine(event.at, trigger, event.unit)
        self._next_tick = self._active_elapsed + TICK_SECONDS

    def _unused_routine(self, phase: str) -> int:
        return max(0, self._routine_capacity(phase) - self._routine_used[phase])

    def _routine_capacity(self, phase: str) -> int:
        reserved = 0 if phase == "FINAL" else 1
        return max(0, PHASE_BUDGETS[_phase_index(phase)] - reserved)

    def _routine_slots_available(self) -> int:
        if self._phase == "FINAL":
            return 0
        reservations_left = sum(
            1 for gate in PHASES[:-1] if not self._reserved_used[gate]
        ) + 1
        global_left = (
            self.budget - len(self._checkpoints) - self._missed - reservations_left
        )
        return max(0, min(self._unused_routine(self._phase) + self._carry, global_left))

    def _consume_missed_routine(self, count: int) -> None:
        own = min(count, self._unused_routine(self._phase))
        self._routine_used[self._phase] += own
        self._carry -= count - own
        self._missed += count

    def _consume_routine(self, at: int, trigger: str, unit: str | None) -> bool:
        phase = self._phase
        if self._routine_slots_available() == 0:
            return False
        own_left = self._unused_routine(phase)
        if own_left:
            self._routine_used[phase] += 1
        elif self._carry:
            self._carry -= 1
        else:
            return False
        self._schedule(trigger, at, phase, unit)
        return True

    def _schedule(
        self,
        trigger: str,
        at: int,
        phase: str | None = None,
        unit: str | None = None,
    ) -> None:
        if len(self._checkpoints) >= self.budget:
            return
        self._checkpoints.append(
            Checkpoint(
                len(self._checkpoints) + self._missed + 1,
                phase or self._phase,
                trigger,
                at,
                unit,
            )
        )

    def to_json(self) -> str:
        """Serialize the append-only event log for restart and deterministic replay."""
        payload = {
            "budget": self.budget,
            "events": [
                {
                    "id": event.id,
                    "kind": event.kind.value,
                    "at": event.at,
                    "phase": event.phase,
                    "unit": event.unit,
                    "disposition": event.disposition,
                    "qualified": event.qualified,
                }
                for event in self._events
            ],
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))

    @classmethod
    def from_json(cls, serialized: str) -> SweepScheduler:
        """Restore by replaying the persisted event log."""
        payload = json.loads(serialized)
        scheduler = cls(payload["budget"])
        for row in payload["events"]:
            scheduler.append(
                Event(
                    row["id"], EventKind(row["kind"]), row["at"], row["phase"],
                    row["unit"], row["disposition"], row["qualified"],
                )
            )
        return scheduler
