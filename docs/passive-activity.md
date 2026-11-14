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
| Right/l | Expand a collapsed branch; otherwise select its first child |
| Left/h | Collapse an expanded branch; otherwise select its parent |
| Ctrl+Space | Set the selected bead as root, including within an existing scope |
| F | Existing focus/restore shortcut |
| Home or H | Restore Current work across all unfinished roots |
| Backspace | Reveal the displayed root’s parent level, keeping the selected bead |
| Space or Enter | Open details; in details, follow the selected relation or focus its pane |
| o | Toggle the selected branch fold |
| b | Switch ownership tree / dependency graph |
| r | Existing ready list and what its work unblocks |
| z | Toggle completed records within scope |
| a | Legacy all/live-agent root filter |
| v | Cycle Current work, Activity and History |
| V | Cycle configured custom views |
| x | Toggle records excluded by configured rules |
| / or Ctrl+F, n, N | Search, next match, previous match |
| y | Copy the complete bead ID |
| t | Toggle pane preview |
| Ctrl-R | Refresh sources |
| ? | Show current bindings; Up/Down scroll the list |

The default tree is an ownership hierarchy: each project-qualified bead appears
once beneath its actual parent. Blocking dependencies do not become additional
parents or inflate ownership progress. Missing parents leave children as roots;
parent cycles are broken deterministically for display and remain qualified.
Dependency evidence, the existing ready/unblocking list, configured views and
relation navigation in details remain available. `b` opens the full dependency
graph, where the same bead can appear through several relationships. These are
references to the same record, not additional work. The footer prefixes ownership
mode with `Tree`; graph mode retains the existing scope label. `dependencies = true` under `[row]`
can select the graph at startup. `--json` retains the complete acquired
graph rather than changing its contract to a UI projection.

Ctrl+Space accepts the conventional terminal NUL / Ctrl+@ encodings. Use `F` if
your terminal intercepts that combination. Rooting from a ready/configured list
opens the selected bead's tree; Home always restores the default ownership view.
The separate Current/Activity/History scope filter remains available in both
presentations.

Current work includes roots with open, in-progress, blocked, hooked or other
unfinished descendants, retaining ancestry. Activity retains work in execution,
prepared or blocked states and finished work awaiting disposition. History makes
old closed roots reachable. Completed toggling changes rows within scope rather
than replacing focus with the entire archive. Explicit focus, folds and selection
survive source refreshes; Home recomputes the default scope.

The row at the bottom of the bead list explains the selected marker (for example,
`[~]: in progress`), above the preview divider or shortcuts. Project and summary
selections have no bead status. Tiny terminals prioritize content and shortcuts.
Centered `...` marks overflow; bottom dots share the status row. Sticky project
headings can share the upper overflow row; see the viewport controls below.

Compact fold arrows retain their branch connectors. Indentation is clipped only
when needed for title space and only in complete configured steps, so expanded
and collapsed rows keep the same columns. A one-cell indent retains the branch
connector and leaves folding to the arrows or `o` rather than dropping the branch for an arrow.

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
colour_brackets = true # false: normal text colour for [ and ], status colour inside
hide_root_indent = "never" # "single-tree" or "always" removes the project-to-bead step
search_mode = "jump" # "filter" keeps matches and their ancestor context
sticky_headers = "active" # "all" pins hidden project headings at both ends; "off" uses dots
preview_min_height = 6 # content rows, excluding the divider; clamped to leave a bead row

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
is inferred from a loose title substring. Alternatively, opt into a general title
regex rule, independent of stored status:

```toml
[hide_titles]
arkham = '^Disposable'
```

Patterns use Rust regex-lite syntax, are case-sensitive unless `(?i)` is used,
and are rejected at load/reload if invalid or empty. A missing project is also
an error. An unanchored pattern matches anywhere; `^` anchors the start of the
title. Either a regex rule or an exact provenance rule can exclude a record.
These are explicit user rules, not automatic classifications. Exclusion is view-only,
counted and reversible using `x`. Do not confuse these disposable records with
legitimate fixture-development work. No historical tracker cleanup is performed.
`z` only changes completed visibility; it never overrides exclusions. Pure
excluded roots/branches disappear rather than leaving `[fixture hidden]` rows;
an excluded ancestor needed to reach visible work remains as masked context.
The `x` override and footer count remain available. Completed work in the
no-live-agent group follows the same `z` rule as ordinary tree rows.

`colour_brackets = true` (the default) colours the entire three-character status
marker. With `false`, `[` and `]` inherit normal row text colour while the centre
character keeps its status colour. This applies to bracket markers in tree,
graph and ready rows. Selection highlighting is preserved in both modes.
Compact branch connectors touch the marker directly, for example `├─[~]`, without
changing the configured indentation step or open/collapsed alignment.

`indent` controls connector width. Compact nested levels add one alignment cell
so branches descend from the centre of the parent's `[x]` marker; the first
project trunk keeps its existing column. For example, at `indent = 2`:

```text
├─[x] Parent
│  ├─[x] Child
│  │  └─[x] Grandchild
```

`H` also returns to Home from details or the bindings screen. Backspace moves
only one containing root level and preserves the current scope/filter and bead
selection. At the highest root it restores the surrounding forest; with no
focused root it does nothing. If a focused refresh omitted the parent, the viewer
requests it through the ordinary collector, without modifying any tracker data.
Backspace still edits the search query while the search prompt is active.

`ascii` provides font-independent connectors and
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
recent task by title or model. It does not enumerate the task directory.
Duplicate rendered copies share that snapshot's collection. Missing identity can
be read from explicitly linked native session logs, as described below.

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


## Search, pointer and viewport controls

`/` and Ctrl+F open the same editable prompt. Jump mode remains the default.
With `[row] search_mode = "filter"`, edits narrow the displayed rows while
retaining ancestors for context. Up/Down moves the selection without ending
editing in either mode. Enter keeps the result/filter; Esc cancels the current
prompt and restores its previous accepted filter. A nonblank accepted filter stays
visible; reopening search restores its query and exact edit cursor. Clear the query
(Ctrl+A, Ctrl+K) and press Enter to remove it, or press Home/H. Whitespace alone
does not apply a filter.
Full IDs, titles and ordinary case-insensitive text searches remain available.

A leading run of status characters selects **any** of those displayed statuses:
`?~` means blocked **or** in progress. After whitespace, text is matched against
the title: `?~ gateway` means one of those states **and** a title containing
`gateway`. Uppercase derived markers (`T`, `A`, `F`) retain their case and mean
exactly what the row's current evidence displays, including freshness handling.
Use `[ ]` (optionally followed by title text) for to-do work, and `x` for stored closed work; search respects the current scope and completed
visibility. A search does not reveal excluded records; use the explicit `x`
override first. Unknown activity is `?` on the right of a row, separate from the
blocked state marker `[?]` at its left.

A click selects a bead. A click on an already selected parent toggles its fold;
a second click on the same bead within 400 ms sets it as root. Ctrl+click reveals
one parent root level and selects the clicked bead. These gestures use the same
root actions as Ctrl+Space and Backspace. The terminal must forward mouse events
and the Ctrl modifier. Sticky project headings are clickable; overflow dots and
the status legend are not bead rows.

`hide_root_indent` names the act of hiding: `"always"` always removes the
project-level indentation, `"never"` keeps it, and `"single-tree"` removes it only
with one displayed project. The former `root_indent` key remains an alias with
its original meaning; existing configurations are not inverted. Use one spelling,
not both. The same rule applies to bead rows, project groups (including trees
with no live agent and unclaimed panes), their children, unread roots, notes and
completed runs. Project groups retain their own expand/collapse marker; global
groups retain their own hierarchy.

`hide_root_indent = "single-tree"` removes the project-to-bead indent when exactly one
project tree is displayed; `"always"` does so for every project. `"never"` keeps
it. Root bead markers then align with the project dropdown column; deeper
trunks still descend from the centre of their parent's marker. This affects
presentation only and does not promote any bead or change ownership.

`sticky_headers = "active"` keeps the current project's name and counts in the
top overflow row. `"all"` pins hidden project headers above and below the visible
content; they join the ordinary list when reached. At tiny heights headers yield
to at least one content row. `"off"` retains a plain top overflow indicator.
The concise selected-status description stays at the bottom of the bead band,
above the preview divider (or above the shortcuts when the preview is hidden).
Bottom overflow dots share that row, and disappear when the end is visible.

Compact right-hand labels use single spaces, place the completion fraction last,
and show unknown activity as `?` or `model · ?`. Details retain the full evidence.
`preview_min_height` sets the minimum preview content rows; a short tree can
leave it more room, and a tiny terminal clamps it to preserve the tree. Delimiter
dragging is not implemented; resizing is controlled through configuration.

## Linked session identity and detail markers

The optional `[omo.<project>] session_directory` is an absolute path to that
project's coordinator session directory. There is no automatic home-wide search.
For example, an invented deployment can configure:

```toml
[omo.arkham]
task_directory = "/srv/arkham/tasks"
session_directory = "/srv/arkham/sessions"
```

A current explicit attempt establishes ownership. A native task's recorded model
remains authoritative. When missing, the adapter follows its worker session ID
into the native task's sibling `children/<task-id>/sessions/<task-id>` directory.
A missing worker ID is recoverable only if that exact directory contains one
unambiguous log whose filename and v3 session header agree. Explicit direct work
can use the exact coordinator session as its worker identity. Delegated work may
show a separately verified coordinator as `model (coord)` when the worker model
is unavailable; it never substitutes that coordinator for the worker. Unresolved
models can still show a shortened worker/coordinator ID; details retain full IDs.
One agent may own multiple beads: each current explicit association is displayed.
Sharing a task/session is not itself a conflict. Explicit native bead, project or
attempt mismatches remain conflicts. Archived attempts do not become current.

An attempt UUID is workflow correlation, not necessarily a runtime session ID or
an attempt-log filename. Existing task records, worker/coordinator session logs
and Beads history hold different evidence; the viewer follows current explicit
links rather than guessing from titles or scanning unrelated historical logs.

Session reads examine header/model-change records only, retaining identity and
file checkpoints rather than transcripts. Directory scans stop at 1,024 entries;
body reads share a 64 MiB budget per collection, and the cache holds at most 256
files. Large initial scans continue on later refreshes; shared owners retain
progress even when another lookup exhausts the budget. Appends are incremental;
partial final records wait for completion. Missing, ambiguous, malformed or
unsupported logs are explained in details. A known model does not establish
current activity, success or acceptance: `model · ?` is valid.

Compact bead details use the same bracket markers and bracket-colour setting in
the heading and related-bead lists (including PARENT and MENTIONS). References to
loaded beads use their current snapshot state; missing references remain explicit.
Legacy detail rendering remains available with the legacy row layout.

Group disclosure arrows and project headings align with the compact tree
verticals. A collapsed bead carries its arrow immediately after the status's
normal separator (`[ ] ▸ title`, or `[ ] > title` in ASCII); opening it removes
the hint without adding a left-side column. Selecting hidden completed work does
not promote its tree into the main section on refresh. Explicit rooting remains
available. Preview rows ignore trailing blank capture padding when deciding
whether content was truncated; genuine clipped text still carries an ellipsis.
