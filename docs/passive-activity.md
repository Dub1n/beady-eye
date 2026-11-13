# Compact trees and passive OmO activity

This fork keeps beady-eye's tree interaction and adds compact rows, explicit
scope navigation and optional read-only native task correlation. The upstream
watcher and explicit write subcommands remain separate capabilities. Opening the
viewer does not start gates, mutate a tracker or require agents to register.

## Installation

The Herdr plugin builds this fork's source using Rust 1.88 or newer:

```sh
herdr plugin install Dub1n/beady-eye
```

Bind `dub1n.beady-eye.open` to a free command key in Herdr's config. To use a
local checkout, run `sh herdr/build.sh` and `herdr plugin link .`; a linked plugin
skips build steps, so rebuild after source changes. The plugin uses `bin/bdi`,
not a potentially different `bdi` on PATH. Standalone installation:

```sh
cargo install --git https://github.com/Dub1n/beady-eye --locked
```

This installation needs no additional agent instructions. Existing upstream
Homebrew/crates.io/releases are upstream builds and do not contain these changes.

## Rows and keys

Rows show a three-character marker and title. IDs and child suffixes are hidden;
Enter shows the full ID, and `y` copies it. Search accepts IDs as well as titles.
Each project has its own header; foreign-project rows remain qualified.

| Key | Action |
| --- | --- |
| Up/down, j/k | Select a visible row |
| Right/l | Make the selected bead the displayed root |
| Left/h below that root | Select its parent |
| Left/h on that root | Reveal the level above without changing the selected bead |
| Home | Restore Current work across all unfinished roots |
| Space | Expand/collapse a branch |
| z | Toggle completed records within scope |
| a | Legacy all/live-agent root filter |
| v | Cycle Current work, Activity and History |
| V | Cycle configured custom views |
| x | Toggle configured disposable fixtures |
| Enter | Open details; Enter there follows a relation or focuses a known pane |
| /, n, N | Search, next match, previous match |
| y | Copy the complete bead ID |
| t | Toggle pane preview |
| Ctrl-R | Refresh sources |
| ? | Show current bindings |

Current work includes roots with open, in-progress, blocked, hooked or other
unfinished descendants, retaining ancestry. Activity retains work in execution,
prepared or blocked states and finished work awaiting disposition. History makes
old closed roots reachable. Completed toggling changes rows within scope rather
than replacing focus with the entire archive. Explicit focus, folds and selection
survive source refreshes; Home recomputes the default scope.

## Markers are not database statuses

| Marker | Meaning |
| --- | --- |
| `[ ]` | Open |
| `[~]` | In progress; working only when current execution evidence confirms it |
| `[<]` | Hooked/prepared |
| `[?]` | Blocked |
| `[T]` | Worker finished; outcome/review/validation may still be pending |
| `[A]` | Explicit evidence says awaiting acceptance |
| `[F]` | Current execution failed |
| `[-]` | Current execution cancelled |
| `[x]` | Recorded closed |
| `[!]` | Conflicting state or evidence; inspect details |
| `[S]` / `[P]` | Stored deferred / pinned status |

Activity refines the in-progress marker. Open, hooked, blocked and closed keep
their stored meaning; incompatible runtime evidence is an additional warning.
Missing or stale execution evidence is qualified as activity unknown. A task
ending does not establish success, acceptance or real-backend validation. A
closed bead stays closed even if its claimed execution contradicts it. `[D]`
for documentation is not inferred. Priority is independent of the warning marker.

A parent's activity and descendant completion fraction are independent: claiming
a parent does not claim its children. Progress counts unique beads across the
rendered subtree, including the parent, with recorded closed/pinned states counted
as finished; configured disposable records are excluded from progress counts
even when inspected with the fixture override. It is not a product-validation metric. Effective model labels
replace repetitive task labels where available. Details retain worker identity,
task, attempt, coordinator, child session and the reasoning behind the state.

## Configuration

In `~/.config/beady-eye/config.toml` (all examples here are invented):

```toml
[[projects]]
name = "arkham"
path = "/srv/work/arkham"

[omo.arkham]
task_directory = "/srv/agents/arkham/tasks"
# Existing metadata convention; paths are configurable.
attempt_path = "metadata.qrclipWork.attempt"
dispatch_path = "metadata.qrclipDispatch"
check_path = "metadata.qrclipWork.checked"
freshness_seconds = 120
max_record_bytes = 262144
# Optional: existing attempt-bound readiness object, not a newly required step.
# acceptance_ready_path = "metadata.reviewReady"

[row]
indent = 2
ascii = false
show_ids = false
compact = true

[tui]
refresh_seconds = 2

[fixture_filters.arkham]
title = "Invented disposable scratch check"
created_by = "invented-test-runner"
close_reason = "Invented scratch cleanup"
```

All configured fixture fields must match exactly and the record must be closed.
`title` and `created_by` are required, plus `description` or `close_reason` (or
both). Description provenance can cover tests that close through acceptance as
well as cleanup, without guessing from their close reason. Nothing
is classified from a loose title substring. Fixture exclusion is view-only,
counted and reversible using `x`. Do not confuse these disposable records with
legitimate fixture-development work. No historical tracker cleanup is performed.

`indent` controls tree spacing, `ascii` provides font-independent connectors and
`show_ids` can restore IDs when wanted. Width fitting reduces optional fields
and truncates rows. Details use available width and can scroll. Plain Beads works
with no `[omo]` configuration; absent activity data remains explicitly unknown.

### Existing workflow metadata and acceptance

The default mapping reads the following shape (invented values):

```json
{
  "metadata": {
    "qrclipWork": {
      "attempt": {
        "id": "invented-attempt",
        "coordinator": "invented-owner",
        "mode": "delegate",
        "preparedAt": "2026-08-01T09:00:00Z"
      },
      "checked": {
        "attemptId": "invented-attempt",
        "passed": true,
        "checkedAt": "2026-08-01T09:05:00Z"
      }
    },
    "qrclipDispatch": {
      "attemptId": "invented-attempt",
      "taskId": "st_invented",
      "childSession": "invented-child"
    },
    "reviewReady": { "attemptId": "invented-attempt", "ready": true }
  }
}
```

`reviewReady` is read only if `acceptance_ready_path` names it. `[A]` requires a
matching completed native task, an attempt-bound readiness object and a passing
current check. A bare boolean, a previous attempt's check, a failed execution or
a missing check cannot establish readiness. If an existing workflow has no such
readiness signal, the correct display is `[T]`; do not add agent reporting work
just to make `[A]` appear. Where the existing check format omits `attemptId`, its
check timestamp must be within the current attempt's preparation/observation
window. Explicit attempt IDs are preferred evidence.

For a workflow with several current worker receipts, `dispatch_path` may name an
array of receipt objects or an object containing `tasks = [receipts...]`. Nested
arrays are rejected. Details retain each worker's execution record; failures,
conflicts and unfinished workers prevent the aggregate claiming all work is done.
Models are labelled `mixed` when they differ. The viewer never writes this schema
or creates extra worker receipts itself.

## Data flow and limits

The viewer reads persistent Beads rows through read-only CLI calls. On each
snapshot it collects each configured project's referenced native task files,
validating the dispatch against the current attempt rather than choosing a
recent task by title or model. It does not scan session transcripts or enumerate
the task directory. Duplicate rendered copies share that snapshot's collection.

The OmO adapter understands native snake_case task records, including task ID,
parent/child sessions, name, agent type, effective model, status and timestamps.
It is an optional adapter for the existing convention, not a generic requirement
that all Beads trackers store those fields. Native on-disk formats may change;
unsupported or partial records degrade explicitly rather than inventing a state.

Dispatch receipts describe admission time. A receipt saying running does not
outweigh a matching native task that has ended. A configured readiness object must name the current attempt and explicitly
record readiness; a bare old boolean cannot establish `[A]`. Multiple receipts
for one bead retain their worker identities and aggregate their states.
Current-attempt validation,
source freshness and identity conflict checks prevent an unrelated or old task
from taking over a bead's display. Completed records remain historical terminal
evidence rather than becoming executing work merely because a file is touched.

Activity follows snapshot refresh cadence (Ctrl-R refreshes now). The configured
poll interval is a gap after a collection completes, not a latency guarantee.
A stopped poll or unreachable tracker limits automatic updates; details expose
source observations and qualifications. Runtime reads are bounded, errors remain
local, and viewing cannot block or authorize an agent's work.

An agent need not own a separate pane. In a configured native integration, a
missing pane alone is not an orphan-claim warning; concrete join conflicts and
stale-claim findings remain visible. Never join a worker to a coordinator's
pane just because they share a project. Existing exact Herdr joins and optional
previews remain available; they are separate from native task outcomes. A known
pane can be focused, while a task without a proven pane still has useful details.

## Validation

Use `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`
and `cargo fmt --check`. The upstream full Nix check additionally covers its
packaging and plugin workspaces. Test inputs must be invented; local task/session
captures and private project data must not be committed.

See [the validation report](validation-passive-activity.md) for the completed checks
and their evidence boundaries. `INTENDED-CHANGES.md` is the agreed design and acceptance checklist. Tests cover
source-to-snapshot correlation alongside renderer and navigation cases; live
installation checks must be reported separately from mocked/PTY coverage.
