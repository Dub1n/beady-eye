# Passive activity fork validation

This report separates invented automated inputs from live local checks. Neither
kind of viewer check establishes that an agent's product changes work or that a
bead has been accepted.

## Check results

- `cargo test --locked --no-fail-fast`: 2,753 passed, zero failed,
  three ignored across 43 reported targets, including doc tests.
- The final ASCII fold-arrow correction was rechecked with all 2,532 library
  tests and the real PTY case at 30, 40, 60 and 80 columns; all passed.
- `cargo clippy --locked --all-targets -- -D warnings` and the separate
  non-test `cargo clippy --locked -- -D warnings`: passed.
- `cargo fmt --check`, `git diff --check` and shell syntax checks: passed.
- `cargo package --locked --allow-dirty`: packaged and verified successfully.
- The fork README source-install check and its negative regression cases were
  extracted from the Nix definition and passed using the local shell. This
  does not substitute for evaluating the full Nix flake.

## Automated coverage

The suite covers persistent status versus execution evidence, current attempts,
identity conflicts, multiple workers and mixed models, explicit readiness with a
passing current check, stale observations, missing/unsupported/partial records,
and rereading execution changes without requiring Beads to change. Readers keep
last-known terminal evidence while qualifying unavailable sources.

Renderer and navigation coverage includes compact three-character markers,
30/40/60/80-column terminals, full-ID details and copying, Unicode cell fitting,
configurable indentation, ASCII connectors, parent claims independent of child
progress, foreign-project qualification, completed visibility, fixture provenance,
focus/reveal/Home navigation and selected work closing during refresh.

The terminal test drives the real application loop against invented native task
files and a shim tracker. It is terminal/application integration evidence, not a
live agent execution or a product acceptance test. All committed inputs are
invented; private tracker, task and pane captures remain outside the repository.

## Local installation

The Linux source-build path is `sh herdr/build.sh`; the manifest runs that same
build and opens its checkout's `bin/bdi`. Local Herdr registration uses
`herdr plugin link .`. A linked plugin must be rebuilt after changing source.
The existing sidebar plugin and its shortcut can coexist with this fork.

A project-specific configuration was installed outside the repository. It maps
the existing task directory and metadata convention without changing the agent
workflow. Disposable records are excluded only by an exact closed-state,
creator, title and description match. This filtering does not delete or modify
tracker records.

## Live read-only checks

The rebuilt release was registered and opened as a Herdr plugin in a dedicated
headless validation session, separate from the user's working panes. The actual
tracker and existing native task files supplied rows with compact bracket
markers, model labels, explicit unknown activity and a visible fixture-exclusion
count. IDs were absent from tree rows and present in the details window.
Activity and History were exercised using the built-in controls; completed rows
were reachable in History. Temporary pane and task captures were not committed.

The user configuration preserves the existing sidebar binding and adds
`prefix+i` for `dub1n.beady-eye.open`; `herdr config check` passed and the server
reported the configuration applied. No additional agent instructions or hooks
were installed. No Beads records were changed by these viewer checks.

## Evidence limits

Linux/WSL is the installation environment exercised here. The manifest retains
macOS support, but macOS execution has not been tested in this session. Nix is
not installed locally, so the full upstream `nix flake check` and plugin-workspace
checks require CI. Cargo checks are reported independently of that gap.

Native task formats and project metadata conventions can change. Unsupported
records degrade to explicit uncertainty; the viewer does not recover, dispatch,
accept, cancel or close work. A recorded closed marker and a completed worker
record are not real-backend validation evidence.

## 0.41.1 tree and viewport follow-up

A reported layout defect came from clipping deep prefixes at a fixed character
limit: this could drop half an indentation step even in a wide pane. Prefixes
now use available width and are shortened only by complete configured levels.
Compact collapsed branches retain their connector as well as the fold arrow;
a one-cell indent retains the branch without an arrow.

The selected marker's description has a reserved row above the shortcuts,
including with the preview hidden. A selected project/summary has no bead status.
The real-terminal test checks the description at 30/40/60/80 columns, alongside
full-ID details and copying.

Centred literal `...` rows indicate tree content above/below the viewport. Tests
cover beginning/middle/end positions, non-clickable indicators, scroll bounds,
selection visibility and tiny viewports. Indicators are omitted below three tree
rows; the status row is omitted below three terminal rows. A details window no
longer refits the covered forest during resizing, preserving the return position.

Follow-up validation: the full Cargo suite passed 2,760 tests with zero failures
and three ignored. Both Clippy modes passed with warnings denied, as did
formatting, diff checks, the extracted source scans and the release build.
The rebuilt `bin/bdi` reports 0.41.1 and matches the canonical release binary.
The new UI behaviour was exercised through the real PTY/application tests;
this follow-up does not claim a fresh live Herdr-pane check.

## 0.42.0 ownership and keyboard follow-up

The default tree projects each project-qualified bead once beneath its actual
parent. Shared blockers remain in the complete acquired graph and in details;
`b` switches to that graph explicitly. The existing ready/unblocking list and
configured views still use the complete dependency source. Ownership counts
measure the ownership subtree rather than unrelated work reached through blockers.
Missing parents leave work as roots; ownership cycles are cut deterministically
for display and retain cycle qualification. Project identity is part of every key.
No tracker records, dependencies or execution evidence are changed.

Right expands a collapsed branch, then enters its first child; Left collapses
an expanded branch, then selects its parent. Space and Enter both open details.
Ctrl+Space (including terminal NUL / Ctrl+@) sets the selected root idempotently,
including within an already focused subtree. F retains the existing focus/restore
action. Root identity is preserved while switching tree and graph presentations.
The ready/configured list can enter the selected tree through that same action.
Home restores the default ownership scope. Existing `d` subtree restoration is
preserved; `o` remains an explicit fold toggle.

Invented collection tests cover shared blockers across roots, project-qualified
ID collisions, missing parents, cycles, unread roots, graph preservation, scope
switching and rooting from the ready list. A real PTY test exercises one-copy
ownership rows versus repeated graph references, Space details and Ctrl+Space
rooting through the application's event loop. The prior narrow-pane tests remain.

Follow-up validation: 2,765 Cargo tests passed with zero failures and three ignored
across 44 reported targets. Both Clippy modes passed with warnings denied, as did
formatting, diff checks, extracted source scans, package verification and release
build. Installed `bin/bdi` reports 0.42.0 and matches the canonical release binary.
This follow-up uses invented collection and real PTY evidence; it does not claim
fresh live Herdr-pane, macOS or full Nix validation.

## 0.42.1 connected markers and bracket colours

Compact branch connectors touch the status marker without changing indentation
width. Fold arrows remain at the end of the connector and open/collapsed rows
keep their alignment. The default `[row] colour_brackets = true` keeps the status
colour on all three marker characters. With `false`, brackets inherit normal row
text colour while the centre retains status colour. Renderer tests check both
settings and selection highlighting, plus ASCII/Unicode branches at indent 1–4.
The real terminal test checks both settings at 30/40/60/80 columns, including
status descriptions, details and copying. No tracker or workflow changes are made.

Full Cargo validation: 2,768 passed, zero failed, 3 ignored across 44 reported targets. Both Clippy modes, formatting, source scans, package verification and release build passed. The installed binary reports 0.42.1 and matches the canonical release build; no fresh live Herdr-pane or macOS/Nix coverage is claimed.

## 0.42.2 marker-centred trunks and parent-root navigation

Compact nested trunks descend from the centre character of the parent marker.
The first project trunk remains fixed; each nested level adds one alignment
cell. Buffer tests verify six levels with ASCII/Unicode connectors, both bracket
colour modes and connector widths 1, 2, 3, 4 and 16. Prefix cropping uses the same
full-level step.

H aliases Home and can leave details/bindings for the default forest. Backspace
reveals one containing root level without changing the selected bead or active
scope. The highest root returns to the surrounding forest; an unfocused view is
a no-op. Search Backspace remains a query edit. Invented collection tests cover
both immediately available ancestry and a focused refresh that omitted the
parent, including preserving bead identity when its rendered path changes.
The real terminal test covers Backspace after entering a lower root and H from
details. Parent reads use the existing collector; no tracker mutation or agent
reporting is introduced.

Follow-up validation: all 2,771 Cargo tests passed, with zero failures and three
ignored across 44 reported targets. The terminal case covers entering a lower
root, Backspace revealing one parent level, and H leaving details for Home.
The collection case verifies deferred parent acquisition and selection retention
after a focused refresh changes the bead's rendered path. Platform and full Nix
coverage limits remain as above.

Both all-target and non-test Clippy checks passed with warnings denied. Formatting,
diff/source scans, package verification and the canonical release build passed.
The installed linked-plugin binary reports 0.42.2 and matches that release build.
No fresh live Herdr-pane, macOS or full Nix validation is claimed.


## 0.43.0 tree controls, filtering and viewport follow-up

Implemented the checked items in the tree/search follow-up in
[INTENDED-CHANGES.md](../INTENDED-CHANGES.md). [AGENTS.md](../AGENTS.md) now makes
maintaining that checklist, the user guide and [PROPOSED-PRS.md](../PROPOSED-PRS.md)
part of future changes. The proposal catalogue records extraction boundaries and
readiness requirements; no contribution has been submitted upstream.

The final full locked Cargo suite passed **2,785 tests, zero failed, 3 ignored
across 44 reported targets**, including the focused rendering regression for
unknown activity without a model (`? 1/4`) and with one (`Luna · ? 1/4`). Tests use invented
records and the existing draining terminal driver. Coverage includes:

- Regex exclusions across stored statuses, invalid/empty patterns, explicit
  override and independence from completed visibility. Hidden matches cannot
  leave unrelated ancestor rows in a live filter.
- Completed visibility inside the no-live-agent group, preserving History root
  discovery and the complete acquired source graph.
- Status-prefix OR queries combined with title text by AND, retained uppercase
  marker case, ordinary case-insensitive text, and clearing filtered ancestry.
- Real terminal Ctrl+F, editable Up/Down navigation, Enter retaining a filter and
  keybinding help scrolling without dismissal.
- Both sticky heading modes and plain overflow, source-row hit testing across
  scroll offsets, tiny heights, last-row selection and root marker alignment.
- Preview minimum clamping, selected-parent folding, double-click set-root and
  Ctrl+click parent-root selection, including a parent outside the loaded
  subtree. A focused partial-snapshot regression verifies that the clicked
  target is still selected after the ancestry collection returns.
- Updated real terminal status-legend checks at 30/40/60/80 columns, retaining
  full IDs in details and the separate dependency/ownership views.

Formatting, Clippy with warnings denied, source scans, package verification and
the canonical release installation are recorded separately from CI. The source
scans are the extracted upstream bounded-walk, module-concern and palette checks;
they are not the full Nix suite. Nix is unavailable locally. No new macOS or live
Herdr-pane execution is claimed, and the user's running pane was not restarted.
Empty GitHub checks must not be read as a CI pass.

The installed binary is built from this checkout with `sh herdr/build.sh` and
reports 0.43.0. Reopening the viewer loads it. The local configuration was backed
up before translating numeric/boolean draft values to the documented enum values
and adding the user's explicit title exclusion; private config values and data
are not included here. Delimiter dragging is not implemented: the preview minimum
is configurable, and its read sizing follows the actual rendered band.


## 0.43.1 consistent project-root indentation

Hidden root indentation now applies to project groups and unclaimed panes as
well as beads, unread roots, notes, orphaned dependencies and completed runs.
Group fold markers remain visible, and global groups retain their own hierarchy.
`hide_root_indent` is the explicit config name; `root_indent` remains an alias
with unchanged semantics. The local key was migrated after a backup, preserving
its value.

Rendering tests cover never/always/single-tree, one/multiple project headings,
Unicode/ASCII, connector widths 1/2/3/16, open/closed project groups, unclaimed
panes, notes, completed runs and independent global sections. Configuration tests
cover all three values using either spelling and rejection of invalid values.

All 44 Cargo test targets are passing (2,787 tests, 3 ignored). The full run's
only failure was the new configuration fixture omitting a required invented
project; after correcting that setup, its entire 111-test target passed.
Clippy with warnings denied, formatting, the three extracted upstream source
scans, clean package verification and the canonical release installation passed.
The installed binary reports 0.43.1. Nix/macOS and a fresh live Herdr pane were
not exercised; reopening the viewer loads the installed version.
