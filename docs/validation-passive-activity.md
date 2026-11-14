# Passive activity fork validation

This report separates invented automated inputs from live local checks. Neither
kind of viewer check establishes that an agent's product changes work or that a
bead has been accepted.

## Orchestrator evidence follow-up, 14 November 2026

The final locked Cargo suite passed 2,852 tests with 3 ignored across 44
reported targets. Both all-target and non-test Clippy with warnings denied,
Cargo formatting, `git diff --check`, and `cargo package --locked --allow-dirty`
passed. The separate Python diagnostic passed 18 invented-data tests. Its Nix
check is defined in `flake.nix`; Nix was unavailable locally, so the full flake
and its additional scans were not locally verified. The independent Sol source
review found no blocking issue after the correlation and diagnostic corrections.

The terminal suite includes a real application-loop PTY test using invented
records: a childless receipt stays unknown and cannot acquire a model,
completion or acceptance from a task file, even with a passing check. This is
not a user-pane or live-worker test.

A read-only real tracker comparison found 42 in-progress rows at that instant:
14 direct attempts and 28 childless delegated receipts. Thirteen referenced
native task files were readable and 15 unavailable in the configured store;
the diagnostic reported the readable children only as unverified observations.
The numbers can change and do not establish that the workers were executing.

An isolated temporary OmO 5.1.69 host authenticated the actual stream module
and returned an empty status-only snapshot. No worker events or complete viewer
path were exercised there. The user's registered host was unavailable when
inspected, so authenticated operation against that host is still unverified.
The canonical `sh herdr/build.sh` installed the tested release binary; no user
pane was restarted or controlled. Non-Linux live transport remains unverified.

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

## 0.44.0 session identity, detail markers and compact-view follow-ups

Missing model identity follows verified worker session IDs or explicitly direct
coordinator sessions. Delegated coordinator identity stays separately labelled.
Ownership is non-exclusive across current bead associations; explicit native
bead/attempt/project mismatches still conflict. Detail headers and related beads
use configured bracket markers with shared drawing/hit geometry.

Invented regressions cover direct/shared ownership, delegated coordinator labels,
missing worker records and unique session discovery, ambiguity, unsupported IDs,
partial appends, replacement/truncation, read budgets and cached progress after
shared-owner lookups. Detail tests cover bracket colours, current related state
and real terminal rendering at 30 and 60 columns. Compact view regressions cover
hidden completed roots remaining in their section across repeated refreshes,
blank-padded versus genuinely clipped preview rows, group/project disclosures,
collapsed root hints, persistent accepted filter text/cursor, Esc restoration,
clearing, whitespace and Home. Existing terminal search tests now explicitly
clear the restored query rather than expecting reopening to discard it.

A private read-only four-collection audit of 40 current attempts recovered worker
or direct model identity for 27 and separately known coordinator identity for
13 by the second collection, stable through the fourth. The initial bounded
collection had 19 unresolved models; subsequent collections resumed cached log
scans. Fifteen native records remained Finished and 25 Unknown throughout: model
recovery did not promote activity or acceptance. This was an adapter audit of a
saved local tracker snapshot plus linked logs, not a fresh live pane exercise or
proof that each owner was currently executing. No private captures were committed.
The local config was backed up before adding its explicit coordinator directory.

Nix and macOS checks are unavailable here. The user's running Herdr pane was not
controlled or restarted. Empty GitHub check results are not a CI verdict.

The full Cargo suite passed: 2,799 tests, zero failures and 3 ignored across 44
reported targets. Clippy with warnings denied (production and all targets),
formatting, all three extracted upstream source scans and clean Cargo package
verification passed. The canonical release installation reports 0.44.0 and matches the release binary byte for byte.

## 0.44.1 fold-hint placement

Nested collapsed beads retain their branch arrows. Only branchless beads use a
hint directly after the status (`[ ]▸ Title`, ASCII `[ ]> Title`). The hint uses
one existing separator cell, keeping the title and its link coordinates aligned
with expanded rows, without changing tracker data or group/project disclosures.
Rendering regressions cover both connector alphabets, nested connector widths
2/3/4, hidden project indentation, and matching expanded/collapsed title columns.
Existing fitting, hyperlink and legacy rendering tests remain in scope because
separator measurement is shared.

All 2,800 Cargo tests passed (3 ignored, 44 reported targets). Formatting,
production/all-target Clippy with warnings denied, and the three extracted
upstream source scans passed. The canonical installed binary reports 0.44.1.
Nix/macOS and a fresh live Herdr pane were not exercised; no pane was restarted.

## 0.44.2 completed folds and mouse details

Preserving a completed selection no longer forces expansion over an explicit
fold choice. Rendering and row counts use the same precedence. Invented
regressions cover nested/focused parents in ownership/dependency views, open and
completed descendants, reopening and collapse persistence through refreshes.

Double-click now opens details through the real Screen/loop hand-off, rather than
setting root. Alt+click selects its target and invokes the existing root action;
Ctrl+click retains parent-root navigation. Modifier decoding, target identity,
detail popup state and help rendering are covered separately. Pointer gestures
remain presentation-only and Ctrl+Space is the keyboard root alternative.

All 2,804 Cargo tests passed (3 ignored, 44 reported targets). Formatting,
production/all-target Clippy with warnings denied and the three extracted
upstream source scans passed. The canonical installed binary reports 0.44.2.
Nix/macOS and a fresh live Herdr pane were not exercised; the user's pane was
not restarted. Empty remote checks do not constitute a green CI verdict.

## 0.45.0 bead-first native live-agent association

The native adapter's current ownership now participates in the pane join before
snapshot construction. A detected OmO application without a reported session ID
can resolve one exact foreground argv session through a bounded, read-only,
Herdr-session-scoped process query. Existing IDs keep priority; ambiguity,
malformed/unsupported envelopes, directory/pane mismatch, unsafe IDs and duplicate
arguments are rejected. At most 32 missing identities are queried per Herdr
session per collection. No native lifecycle report or Beads update is issued.

A private live case revealed both a missing runtime identity and ownership lost
when a displayed dependency tree used the across-project assembly path. The join
now uses validated per-project source rows independently of that projection.
The corrected live JSON read associated 17 unfinished current attempts with one
pane: 3 worker/direct links and 14 coordinator links, with zero unclaimed panes
for that source. All 17 carried verified argv provenance and coordinator model
identity. Native execution remained Finished for 10 and Unknown for 7; stored
statuses remained in-progress for 13 and hooked for 4. The primary live pane was
counted once. These are point-in-time association observations, not proof of
simultaneous per-bead execution or acceptance. Private identifiers, captures and
paths were not committed, and the running user pane was not controlled.

Invented tests cover exact process parsing, canonical ID precedence, lookup
bounds, current/shared/missing/old/cross-project/ambiguous ownership, native
completion alongside a live coordinator, explicit worker/pane disagreement,
source-to-snapshot association through across-project assembly, deduplicated
counts, preview targeting and removal of liveness when a terminal disappears.
Real terminal tests at 30/60 columns verify visible live/role markers and opening
linked details. Headless workers retain native activity evidence without gaining
a fabricated pane. Primary preview prefers an explicitly linked worker, then the
coordinator; additional native pane links remain in execution details.

One full run failed the existing undrained-terminal quit check while other builds
were active; its unchanged two-test target subsequently passed. The first live
readback also caught the need to exercise actual provider envelopes and the
across-project ownership path rather than relying only on isolated fixtures.
Those failed/private outputs were retained outside the repository. Nix/macOS
and a fresh interactive Herdr viewer were not exercised.

The final full Cargo suite passed: 2,814 tests, 3 ignored, 44 reported targets.
The native-join target was rerun after adding the explicit old-session case;
all five tests passed. Production/all-target Clippy with warnings denied,
formatting and the three extracted source scans passed. The canonical installed
binary reports 0.45.0. Live JSON validation and invented PTY coverage are separate
from exercising the user's interactive viewer after reopening it.

## 0.46.0 independent execution and session switches

A read-only investigation found current attempts referring to a newer logical
session than the live process's launch argument. The native registry identifies
the current session by process PID; verification now additionally requires the
same process lifetime, project store, registered and bound socket inode, and
matching session header. Native hard-link and symlink socket layouts are covered.
Ambiguous or unsupported evidence clears the launch-ID fallback. Canonical
provider IDs remain authoritative. The configured registry was added after a
local config backup; no tracker or agent workflow was modified.

The source snapshot changed during validation: two previously reported attempts
closed and a third remained open without an attempt or assignee. A later live
JSON read linked seven current beads to the live pane, with no runtime-identity
errors: one active, three inactive and three unknown. This is a point-in-time
read, not a claim about the earlier agent message or simultaneous execution.
No real IDs, paths or session records are included in test fixtures.

The full Cargo suite passed 2,820 tests with 3 ignored; after the socket-layout
fix all five focused runtime tests passed. All-target Clippy, formatting and
available extracted source scans passed. Real terminal tests and a state matrix
cover idle/live/active labels; Linux live JSON was checked separately. Nix,
macOS and a newly reopened interactive Herdr pane were not exercised.

## Worker evidence refinement (0.47.0)

The full locked Cargo suite passed 2,844 tests (3 ignored) across 44 reported
targets. Focused native transport, observed history and narrow-view tests passed;
all-target Clippy, formatting and extracted repository scans passed. Tests use
invented identities and synthetic protocol peers. The optional Linux native
status transport has not yet been verified against a live authenticated host:
the inspected host advertised a public authentication challenge but its key
record was unavailable. Session headers and model-change metadata are used for
identity, not conversational attribution. Nix and macOS were not available.
