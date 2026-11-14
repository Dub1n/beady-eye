# Proposed upstream pull requests

This is an extraction plan for changes in this fork, not a claim that the patches
are ready to submit or that the maintainer has agreed to them. Each proposal must
stand on its own against upstream, with its own rationale, tests and CI evidence.
The fork can continue evolving while individual proposals are prepared.

Reviewed on 2026-11-14 against upstream
`6cebfddd045ee6468ed06b6deb77b4748d536a3d` and fork
`a4098292bd9b61e9557b1b5f89400c4fc30e1f7a` (0.42.2). Upstream's current head matched
that upstream commit when checked. Recheck upstream history, issues, PRs and these
instructions before starting an extraction; this document will become dated.

The completed tree/search follow-up is included as 0.43.0 notes and proposals
11–13 below; it does not constitute a fresh upstream-head review.

The source pointers below refer to this fork. They are starting points, not
cherry-pick instructions. Our large initial implementation and later corrections
combine unrelated features, changed defaults and test-fixture adaptations.

## Contribution requirements and shared readiness gate

Read the current upstream versions of [CONTRIBUTING.md](CONTRIBUTING.md),
[CLAUDE.md](CLAUDE.md) and [docs/design.md](docs/design.md) in the clean upstream
worktree. The fork-specific overrides at the top of our design/configuration docs
are not upstream policy. The upstream copies are also available at
[CONTRIBUTING.md](https://github.com/CodeForBreakfast/beady-eye/blob/main/CONTRIBUTING.md),
[CLAUDE.md](https://github.com/CodeForBreakfast/beady-eye/blob/main/CLAUDE.md) and
[design.md](https://github.com/CodeForBreakfast/beady-eye/blob/main/docs/design.md).

Apply the following to **every** proposal:

1. **Start with an issue.** CONTRIBUTING's reporting/proposal section asks for a
   [GitHub issue](https://github.com/CodeForBreakfast/beady-eye/issues). Search
   existing issues and PRs first, then describe the concrete problem and proposed
   scope. Security reports follow SECURITY.md instead of public issues. These
   notes are local preparation, not instructions to automatically publish issues.
2. **Keep the design discussion distinct from a rule.** Seeking agreement before
   substantial UI or model changes is this plan's recommendation. The contribution
   guide requests an issue; it does not promise acceptance or explicitly require
   approval for every implementation detail. Record the maintainer's actual
   response and agreed boundaries rather than inferring consent.
3. **Preserve the project's boundaries.** CONTRIBUTING and CLAUDE require workflow
   independence, project-qualified bead identity and visible degradation. Use
   `(project, id)`, retain evidence of failed/unreachable sources and missing
   relations, and keep metadata semantics out of generic model code. Do not add
   tracker writes, agent reporting duties or orchestration merely to draw a view.
4. **Use upstream terminology and layers.** Reuse Beads/Herdr concepts. If a new
   term is necessary, add it to the terminology table in design.md as coined.
   Keep collection, orchestration/cache, model, rendering and terminal-loop work
   in their existing layers. Follow the working notes' conventions for user-facing
   wording and palette selection.
5. **Invent all examples.** CONTRIBUTING's Tests section forbids real captures,
   including seemingly harmless IDs, paths, sessions, hosts and descriptions.
   Extend the existing invented fixture vocabulary. Never copy private project
   logs, native task files, pane captures or local configuration into a PR, issue
   reproducer or documentation example.
6. **Extract onto fresh upstream.** Reproduce the problem first where applicable.
   Implement only the proposal and any explicitly declared prerequisite. Preserve
   upstream defaults unless a default change was agreed. Exclude fork branding,
   repository URLs, version bumps, source-build plugin packaging, local deployment
   configuration and unrelated formatter/lint churn. Follow upstream's release
   procedure rather than copying the fork's version numbers.
7. **Use the existing test machinery.** CLAUDE's testing notes require the draining
   PTY driver in `tests/terminal/driver.rs`; never read its master independently or
   stop draining while waiting. For window absence, use `window_over(...).is_none()`;
   absence of a former title does not prove the window closed. Put non-process,
   non-environment-mutating integration cases in `tests/never_start_bdi/`; each new
   top-level integration file adds a binary/link. Use the bounded keyboard-walk
   helper in `src/view/walk.rs` where relevant, and satisfy the source scans in
   flake.nix. Do not weaken tests or change production defaults under `cfg(test)`.
8. **Validate the extracted tree, not this fork's aggregate.** Enter `nix develop`,
   run focused checks while working, then commit the intended files and leave a
   clean worktree before running `check-before-push`. The guide explains that its
   dirty-tree refusal prevents checking a different source from the intended
   change. The full flake covers build/tests, both relevant Clippy surfaces,
   formatting, package verification, plugin workspaces and repository scans.
   Add any new CI check to the flake's `checks` output. Use
   `mutation-test-this-change` when useful for a subtle behavioral change or
   requested by review; its availability is not a blanket requirement to run it
   on every documentation or styling change.
9. **Prepare the upstream PR correctly.** Changes reach main through a PR and a
   squash merge. Validate the title with `conventional-subject '<title>'`: allowed
   type and scope, imperative description, no final full stop, maximum 72
   characters. The examples below use permitted scopes and are tentative titles,
   not reservations. Explain the problem, resulting behavior and relevant
   validation in the body; the squash retains that body too.
10. **Require an actual CI verdict.** CLAUDE points to `read-ci-verdict [<commit>]`.
    Run it for the submitted commit and inspect any failures. An empty list of
    GitHub checks is not success. Local Cargo checks or extracted shell scans are
    useful evidence but are not equivalent to the full Nix checks or PR-title job.
    Update or rerun checks after code changes as appropriate.

A proposal is merge-ready only after its independent behavior and compatibility
are demonstrated, required checks have passed for its actual submitted revision,
and upstream review requirements are met. None is certified merge-ready by this
planning document. The fork's existing test totals and
[validation report](docs/validation-passive-activity.md) provide extraction leads,
not transferable upstream approval. Nix/macOS gaps recorded there must not be
silently promoted into upstream coverage claims.

## 1. Preserve selection when a focused snapshot changes paths

**Priority:** first candidate to investigate; potentially a small independent fix.

**Tentative title:**
`fix(view): retain selection when a focused snapshot changes paths`

**Problem and scope:** A focused collection can rebuild a selected bead as a tree
root rather than beneath its previous root. Preserve the selected bead's identity
when its old rendered path is no longer present. Do not bundle new views, status
markers, root-up navigation or changes to collection policy.

**Starting points:** `Forest::refresh` and `rerooted` in
`src/view/forest/mod.rs`; the focused-partial-snapshot case in
`tests/never_start_bdi/hierarchy.rs`.

**To become independent and merge-ready:**

- Reproduce this exact loss of selection against untouched upstream using its
  existing focus action and collection behavior. A fork-only failure is not an
  upstream bug; withdraw or reclassify the proposal if it does not reproduce.
- Reduce the fixture to the original graph representation. The reproducer must
  not need the ownership projection, OmO fields, the parent-root pending-selection
  field or this fork's changed defaults.
- Keep an existing rendered copy when its path is still valid. Only resolve by
  project-qualified identity when that path changes; retain the existing fallback
  to a surviving ancestor when the bead actually disappears.
- Test partial focused collections, reparenting, duplicate graph references,
  tracker refusal/recovery, same IDs in different projects and genuine deletion.
- Demonstrate the regression fails before the fix and passes after it, then
  complete the shared readiness gate.

**Boundary:** Do not automatically include the details-resize change. That was
needed alongside our new viewport-fitting behavior and may repair a fork-induced
regression. It needs a separate upstream reproducer before being called a bug fix.

## 2. Indicate hidden rows above and below the viewport

**Priority:** strong standalone UI proposal; moderate shared-code maintenance value.

**Tentative title:**
`feat(view): show hidden rows above and below the viewport`

**Problem and scope:** Make off-screen tree content discoverable using top/bottom
indicators. Indicator allocation, visible content capacity, selection reveal,
scroll limits and inverse click mapping form one change; extracting only the
painted `...` rows would be incomplete.

**Starting points:** `src/view/draw/bands.rs`, the forest drawing loop in
`src/view/draw/mod.rs`, viewport methods in `src/view/forest/mod.rs` and tests in
`src/view/forest/tests/viewport.rs`.

**To become independent and merge-ready:**

- Discuss whether indicators are always shown, optional or styled differently.
  Avoid reserving the fork's selected-status row as an undeclared prerequisite.
- Port the geometry to upstream's existing graph, tail and key-bar layout.
- Test beginning, middle and end; one or both indicators; first/last selection;
  keyboard motion, wheel scrolling, resizing and pointer selection. Indicators
  must never identify a bead or obscure the selected row.
- Define tiny-height and tiny-width behavior. The fork omits indicators below
  three tree rows and clips the literal text at very small widths.
- Test details-window resize/return behavior with the extracted fitting changes.
  Include any necessary preservation fix here, without mislabelling its origin.
- Keep lazy counting and materialized rows consistent; use invented graph diamonds
  and cycles, not only flat lists. Complete the shared readiness gate.

**Maintenance benefit:** This can remove recurring fork edits to shared viewport,
selection and click geometry, rather than merely removing a cosmetic diff.

**Fork follow-up (2026-11-14):** Added `sticky_headers = "active" | "all" | "off"`.
Active pins the current project; all pins hidden project headings at both ends.
A shared bounded viewport plan drives painting and pointer mapping without
materializing hidden lazy subtrees. Selection reveal and scroll limits account
for pinned headings. The selected-status legend now shares the bottom overflow
row above the preview. For extraction, keep sticky headers optional, resolve
header/dots collisions at narrow widths, and either omit the legend or explicitly
stack proposal 5. Cover multi-project transitions, tiny heights, last-row reveal,
mouse inverses and both modes. The fork's `compact_controls` tests exercise these
cases; rebase them onto upstream's original layout rather than its fork defaults.


## 3. Configurable indentation and ASCII connectors

**Priority:** strong general-purpose presentation proposal; a useful renderer base.

**Tentative title:**
`feat(view): configure indentation and ASCII tree connectors`

**Problem and scope:** Accommodate narrower panes and terminals/fonts that cannot
render the existing connector vocabulary reliably. Keep upstream's current
Unicode appearance and indentation as the default.

**Starting points:** `src/view/lines.rs`, `src/view/row.rs`,
`src/view/forest/layout.rs`, `src/view/forest/ready.rs` and config parsing/tests.

**To become independent and merge-ready:**

- Agree on configuration names, valid ranges and whether spacing means connector
  width or total depth increment. Do not copy our latest meaning without review:
  compact bracket rows add a centre-alignment cell at each nested level.
- Separate adjustable connectors from the three-character marker choice. A
  single-glyph upstream row must not inherit bracket-specific alignment offsets.
- Apply the policy consistently to roots, folded/open branches, ready-list
  expansions, foreign dependencies, missing-dependency notes and grouped runs.
- Preserve branch connectors when fitting fold arrows at small indentation values;
  explicitly define when an arrow must be omitted rather than dropping the branch.
- Test widths/alignment across several depths, open/closed folds and both connector
  sets. Keep upstream's original default snapshots valid.
- Specify the ASCII option's limits honestly: tree connectors/markers are not the
  same as an entirely ASCII TUI, which also has borders and other symbols.
- Complete the shared readiness gate and document the configuration upstream.

**Fork follow-up (2026-11-14):** `root_indent = "never" | "single-tree" | "always"`
can suppress the project-to-bead step while retaining nested marker-centre
alignment. Never is the fork default. Single-tree counts displayed project
headings, not configured-but-absent projects. Extract this independently of
ownership, activity and search; test zero/one/multiple projects, focused roots,
Unicode/ASCII, ready/dependency rows and changing visibility on refresh. Preserve
canonical paths and clickable row identity when cropping prefixes.


## 4. Preserve useful titles in narrow tree panes

**Priority:** strong practical benefit; likely more extraction work than its name suggests.

**Tentative title:** `feat(view): preserve titles in narrow tree panes`

**Problem and scope:** Prevent long identity prefixes and optional state fields
from consuming the usable title area. Fit in display cells, keep a bead on one
row, and preserve accessible details for omitted information.

**Starting points:** `src/view/fitted.rs`, the compact fitting call in
`src/view/draw/bead.rs`, and `tests/a_compact_passive_view.rs`.

**To become independent and merge-ready:**

- Express this as an optional fitting/density policy, or agree on a universal
  improvement. Do not silently adopt ID-free rows or the fork's compact defaults.
- Build an ordinary Beads-only PTY fixture: remove native task configuration and
  derived execution markers from this proposal's tests.
- Retain upstream's canonical search/copy/detail identity. Upstream already allows
  layout cells to be configured; determine whether that is sufficient to omit IDs
  before proposing a redundant `show_ids` switch.
- Crop connector prefixes only at complete effective depth steps. Agree on the
  trade-off between preserving ancestry and reserving title space; do not restore
  the arbitrary fixed prefix cap that caused an earlier fork alignment defect.
- Verify 30/40/60/80 columns, deep trees, Unicode wide/combining characters, styles,
  hyperlinks, badges, selection and readable status/title retention. All omitted
  data should remain reachable through existing details.
- Complete the shared readiness gate. Coordinate with proposal 3 if it supplies
  the configurable depth step; otherwise declare and test a fixed upstream step.

**Not a new feature to claim:** Upstream already supports narrow details windows
and standard arrow traversal. Our tests exercise these existing capabilities;
there is no independent narrow-details implementation to contribute here.

**Fork follow-up (2026-11-14):** Compact state labels now use single spaces and
put completion after other state cells. Unknown activity is `?`, with `model · ?`
only when a model label exists. Upstream can take generic spacing/order fixes
without the native activity provider. Keep configurable legacy cell order and
original snapshots intact; any evidence-specific label needs proposal 9 or an
accepted configurable source. Add long/absent/shortened-label and narrow-row tests
before extracting, including the remaining trailing notes and warning policy.


## 5. Optional bracket markers, colours and a status description

**Priority:** useful optional presentation work; relatively modest maintenance savings.

**Tentative base title:** `feat(view): add optional bracket status markers`

**Problem and scope:** Offer readable three-character markers such as `[ ]`,
`[~]`, `[?]` and `[x]` without requiring an icon font. Offer normal-colour brackets
versus brackets matching the status character, and optionally explain the selected
status near the shortcuts.

**Starting points:** `src/view/appearance.rs` (included by row.rs),
`src/view/draw/bead.rs`, `src/view/row.rs`, and the selected-status reservation in
`src/view/draw/mod.rs` and `src/tui/screen.rs`.

**To become independent and merge-ready:**

- Discuss marker vocabulary and opt-in configuration first; upstream treats glyphs
  as terminology. Preserve its default glyphs and status meaning.
- Initially support stored Beads statuses only. `[T]`, `[A]`, `[F]` and execution
  conflicts need an independent, accepted evidence source; they must not pull in
  proposal 9 or imply acceptance/verification from a closed record.
- Prefer small reviewable stages: base bracket rendering, then its colour option,
  then the optional selected-status description if wanted. The colour change
  depends on bracket support; the legend could instead explain existing glyphs.
- Keep palette decisions in palette.rs and user-facing descriptions consistent
  with phrase.rs/design terminology. Inherit normal row colour for neutral
  brackets; preserve the centre's status colour and selection treatment.
- Define child-connector alignment for one-cell versus three-cell markers. The
  fork's marker-centred geometry is a choice to discuss, not an upstream bug fix.
- Test all supported statuses, unknown-status fallback, both colour modes, selected
  and inactive rows, no-activity operation and narrow widths. Test the legend with
  the tail shown/hidden, project/group selection and tiny terminal heights.
- Complete the shared readiness gate for each independently submitted stage.

**Fork follow-up (2026-11-14):** The concise selected-status description is now
fixed at the bottom of the bead band, above the preview divider, sharing its row
with bottom overflow dots. Labels include `hooked`, `blocked` and `validation
pending`. An independent version can show stored-status descriptions only; do
not require OmO, sticky headers or the fork's marker vocabulary. Coordinate the
single reserved row with proposal 2, test preview on/off and tiny/narrow screens,
and retain semantic distinctions between finished execution and stored closure.


## 6. Optional parent-child tree alongside the dependency graph

**Priority:** high potential maintenance benefit; design discussion before major extraction.

**Tentative title:** `feat(view): add an optional parent-child tree view`

**Problem and scope:** Some readers want one occurrence per bead beneath its actual
parent, while the existing graph intentionally repeats beads through different
relationships. Offer both presentations without presenting graph references as
extra records or changing the meaning of upstream's existing graph.

**Starting points:** `src/model/snapshot/hierarchy.rs`, the retained dependency
source and projection switching in `src/view/forest/mod.rs`, and invented
collection tests in `tests/never_start_bdi/hierarchy.rs`.

**To become independent and merge-ready:**

- Explain why the existing spine rules are not equivalent: they choose which copy
  opens but do not remove other references. Preserve the graph as upstream's
  default unless a default change is explicitly agreed.
- Agree on terminology, configuration, shortcut and layer ownership. The fork puts
  its startup preference in row layout; upstream may prefer a distinct view policy.
- Keep every available bead once by `(project, id)`, including beads reached only
  through dependencies. Preserve disconnected components, missing parents,
  cross-project relationships and visible qualification of malformed cycles.
- Retain complete dependency evidence for details, ready/unblocking lists and
  configured views. Do not change the existing JSON contract just because the UI
  is projected differently.
- Define counts explicitly: ownership-subtree progress versus dependency-reachable
  progress. Neither establishes functional acceptance.
- Prove focus, search, copying, selection, folds, refresh and source failures work
  in both presentations. Account for focused collections that omit ancestors,
  reparenting, filtered/closed selected beads and foreign-project headers.
- Check large/deep/shared graphs for bounded traversal, memory and refresh cost.
  Avoid retaining duplicate full data unnecessarily; do not defeat lazy rendering.
- Extract without native execution, new default scope filters or keyboard
  remapping. Complete the shared readiness gate after the design is settled.

## 7. Optional unfinished/history scope filters

**Priority:** useful independent feature, subject to explicit status and scope policy.

**Tentative title:** `feat(view): add unfinished and history scope filters`

**Problem and scope:** Make unfinished roots and older closed work independently
reachable, with a separate completed-within-scope toggle. Preserve upstream's
current filtering default unless a different default is agreed.

**Starting points:** `src/app/tracker.rs`, `src/model/snapshot/filter.rs`, scope
switching and selected-closure retention in `src/view/forest/mod.rs`.

**To become independent and merge-ready:**

- Separate root discovery/retention from presentation filtering. Historical-only
  roots must be available without an unrelated recollection, but bounded/focused
  collection and watcher behavior must remain correct.
- Define every supported stored status: blocked and hooked work, deferred/pinned
  records, unknown future statuses and closed parents with unfinished descendants.
  Reuse Beads/upstream semantics instead of treating status names as proof of work.
- Keep toggling completed descendants within the inspected scope. Make access to
  unrelated historical roots explicit; do not unexpectedly replace a focused tree
  with the entire archive or drop selected work when it closes.
- Leave execution-based Activity filtering out of the first proposal. It depends
  on proposal 9 or another accepted evidence source, unlike stored-status scopes.
- Treat disposable-fixture exclusion as a separate optional filter discussion,
  not a default upstream title blacklist. Any generic mechanism needs explicit
  predicates, a visible count and an override. Private test litter is not a reason
  for upstream to encode a project's fixture conventions or mutate old records.
- Test root scope, ancestry, all status categories, watcher/refresh changes,
  tracker failures, completed toggles and inspection retention. Complete the
  shared readiness gate without requiring proposal 6 unless intentionally stacked.

**Fork follow-up (2026-11-14):** Completed visibility now also filters roots
inside the no-live-agent group. Explicit `[hide_titles] project = '^Invented'`
regex rules generalize exclusions to any stored status. Invalid/empty patterns
and unknown projects fail config loading; prior exact provenance rules remain
supported. Exclusions are independent of `z`, counted and reversible through `x`;
pure hidden branches leave no placeholder, while necessary ancestry remains
masked context. Treat regex exclusions as a separate upstream proposal or
clearly declared optional stage, without the fork's private fixture conventions.
Tests must cover anchored/case-insensitive patterns, config reload failure,
open/closed records, ancestry, override, source preservation and no-agent groups.


## 8. Parent-root navigation and optional shortcut aliases

**Priority:** small-to-medium optional navigation proposal; keep key choices separate.

**Tentative title:** `feat(tui): reveal the parent of a focused root`

**Problem and scope:** Reveal one containing level after focusing a lower bead,
while keeping that bead selected and retaining the current filter. Existing
upstream Left/Right traversal and F focus/restore remain available.

**Starting points:** `RootUp`, deferred selection restoration and root selection
in `src/view/forest/mod.rs`; `src/tui/keys.rs`, `src/tui/drive.rs`, the collection
ancestry tests and real terminal case.

**To become independent and merge-ready:**

- Start from upstream's existing focus action and graph. Do not require the
  ownership projection or replace standard arrow behavior.
- Discuss Backspace versus another binding and document collisions. Backspace
  must remain a query edit while searching. Define behavior at a highest root,
  with no focused root, multiple focused roots and unavailable/malformed parents.
- Preserve the selected bead through immediate and asynchronously collected
  ancestry. Separate the proposal-1 identity fix if it is a genuine prerequisite;
  use project-qualified parent metadata only with an explicit fallback policy.
- Test collection narrowing, parent failure/deletion/reparenting, normal graph
  copies, refresh during navigation and pending navigation cancelled by Home or
  another scope choice.
- Discuss H/Home aliases and idempotent root selection as separate additions if
  desired. Ctrl+Space requires NUL/Ctrl+@ handling and a fallback when intercepted
  by a terminal. Update the key table, help and descriptions together.
- Do not include the fork's Space-to-details rebinding as a prerequisite. It is a
  preference that changes an existing binding and needs explicit discussion.
- Complete the shared readiness gate. Any claimed existing upstream navigation
  defect still needs its own untouched-upstream reproducer.

**Fork follow-up (2026-11-14):** Double-clicking a bead invokes the existing
set-root action; Ctrl+click invokes parent-root navigation and selects the clicked
bead. Record the clicked identity before parent lookup so a deferred ancestry
collection restores that target rather than the former selection. The fork has
an invented partial-snapshot mouse regression for this case.
Clicking an already selected parent toggles expansion. Keep gesture
recognition, identity, viewport hit-testing and modifier forwarding together;
exclude tracker/provider code. Test repeated titles across projects, the 400 ms
boundary, changing rows between clicks, sticky headings, blank/legend clicks,
focused ancestry after refresh and terminals lacking Ctrl+mouse support. Mouse
support is separable from rebinding keys. Always redraw a changed root scope
even if its visible rows happen to remain identical.


## 9. Passive native execution information through an optional adapter

**Priority:** deferred architectural proposal, not a direct upstream-ready patch.

**Tentative eventual title:** `feat(collect): read optional native task activity`

**Problem and scope:** Show execution information already produced by a tool
without adding agent reporting commands or requiring each worker to own a pane.
This is distinct from the Herdr pane/liveness information upstream already owns.

**Starting points:** `src/collect/omo.rs`, its config mapping, the cached readers
in `src/app/collection.rs`, snapshot activity fields and execution details.

**To become independent and merge-ready:**

- First ask whether upstream wants another execution source at all. If not, keep
  this in the fork or a separately maintained adapter. Do not put unused generic
  provider scaffolding upstream on the assumption a later adapter will be accepted.
- If wanted, agree on a minimal provider contract and extension boundary. Keep
  native record parsing in collect, cache/refresh in app and display in view.
  Generic snapshots must not understand private metadata keys or gate semantics.
- Remove project-specific default paths/metadata meanings and hardcoded model
  aliases from generic logic. Mere renaming is insufficient: attempt matching,
  receipt interpretation, readiness and check semantics must be explicitly owned
  by adapter configuration or an agreed source protocol.
- Preserve current-attempt correlation, `(project, id)` identity, multiple workers,
  source provenance and last-known evidence. Dispatch is not liveness; worker
  completion is not success, functional validation or acceptance. Persisted Beads
  status remains authoritative and is not rewritten by the viewer.
- Revisit warning suppression. The fork relaxes missing-pane warnings for native
  integrations; an upstream proposal must not hide a genuine orphan/stale claim
  merely because a provider is configured. Specify when matching evidence is
  sufficient and retain concrete conflicts and source failures.
- Bound reads and caches, handle partial/missing/unsupported records and source
  schema changes, and test refresh without Beads mutations. Define how failures
  are surfaced instead of silently dropping project or worker information.
- Use invented fixtures and neutral worked examples. Do not copy local task data,
  model policy, acceptance workflow or project configuration. Finish the shared
  readiness gate only after agreement on the architectural boundary.

**Maintenance implication:** An accepted small extension point plus a separately
maintained adapter could reduce core conflicts, but adds a contract to maintain.
Assess that trade-off before building a framework around one integration.

## 10. Portable missing-program test environments

**Priority:** optional small test-only proposal; low product-diff reduction.

**Tentative title:**
`test: make missing-program fixtures portable across PATH layouts`

**Problem and scope:** Missing-command tests can accidentally remove required shell
utilities when omitting a directory that also holds the intentionally absent
program. Inaccessible inherited PATH entries can also turn an expected ENOENT into
EACCES. These are test-ground problems, not reasons to weaken production errors.

**Starting points:** `tests/terminal/shims.rs` and the isolated absent-wrapper case
in `src/collect/environment.rs`.

**To become independent and merge-ready:**

- Reproduce against unmodified upstream. Split the two problems if they warrant
  separate fixes; prefer the smallest deterministic test environment.
- Preserve the distinction between a missing and a non-executable program. Supply
  only necessary invented/test utilities and do not accidentally reintroduce the
  intentionally absent executable through another PATH directory or alias.
- Test both ordinary and permission-restricted PATH layouts, same-directory utility
  dependencies and supported Unix platforms. Avoid global environment mutation
  in parallel tests; use isolated child environments or explicit paths.
- Never commit real inherited PATH values, host directories or usernames. Explain
  platform constraints honestly and do not claim untested macOS behavior.
- Keep this free of viewer, workflow and packaging changes, then complete the
  shared readiness gate.

## 11. Optional live search filtering and status queries

**Tentative title:** `feat(view): add optional live search filtering`

**Fork implementation:** `[row] search_mode = "filter"` retains matching rows and
ancestor context; jump remains the default. Ctrl+F aliases `/`. Up/Down navigates
without ending prompt editing. A leading status run ORs its markers; title text
after whitespace is ANDed (`?~ gateway`). Source relations and JSON stay intact.
Tree projection uses bounded reverse reachability, including shared dependencies
and cycles. Ready/configured lists filter matching entries directly.

**To become independent and merge-ready:** Start with text filtering against
upstream jump search. Agree on Enter/Esc/clear semantics, context-row styling,
focused ancestry, automatic ancestor expansion and whether status syntax is a
second PR. Keep stored-status matching independent of execution adapters; derived
markers need an accepted presentation/evidence source. Preserve case in marker
prefixes while retaining ordinary case-insensitive text search. Test repeated
queries, no matches, filtering after acceptance, clearing, prompt arrow editing,
refresh/fold interactions, projects sharing IDs, lists and large graphs. Ensure
upstream match counts and next/previous-match traversal respect exactly the same
scope, exclusions and visibility as rendering. Profile per-edit projection before
making scalability claims. Reuse the invented PTY filter/arrow regression and
source-preservation tests; complete the shared contribution gate.

## 12. Scroll the keybinding overlay

**Tentative title:** `feat(tui): scroll keybinding help with arrow keys`

**Fork implementation:** Up/Down scroll the overlay without dismissing it. Other
keys retain dismissal behavior. Offset is owned by the screen, row drawing is
bounded and the final page includes the last binding.

**To become independent and merge-ready:** Extract only bindings drawing, screen
scroll state and event dispatch; no ownership, activity or search prerequisites.
Agree on reset-on-open versus retained offset, wheel behavior and PgUp/PgDn if
wanted. Test reaching both ends, one-row windows, resize/clamped offsets, a table
shorter than the screen and dismissal. Update the title and upstream tests that
previously promised *any* key dismisses. Retain draining PTY tests and avoid
adding a process integration binary for a pure rendering test. Complete the
shared gate; this is a small candidate to extract early.

## 13. Configurable minimum preview height

**Tentative title:** `feat(view): configure the minimum pane preview height`

**Fork implementation:** `[row] preview_min_height` sets preview content rows,
excluding its delimiter. Available height clamps the minimum to retain a tree
row; short trees may leave additional room. Drawing, pointer mapping and pane
read sizing use the same band calculation. Delimiter dragging is intentionally
outside this increment because it requires a drag-event path.

**To become independent and merge-ready:** Put the setting in the appropriate
upstream preview configuration section and preserve upstream's current default
band geometry. Remove the fork legend/sticky-row dependency or explicitly stack
proposal 2/5. Test smaller/larger/zero minimum, preview hidden/shown, resize, short
and tall trees, content read sizes and tiny screens. Do not introduce mouse drag
handling just to extract the setting. Complete the shared contribution gate.

## Recommended extraction order and maintenance strategy

1. Investigate proposal 1 on untouched upstream, and optionally proposal 10.
   A compact reproducer is more valuable than submitting a presumed bug.
2. Discuss optional connector/density work (3 and 4) and overflow indicators (2).
   These are broadly useful and overlap files we otherwise keep merging by hand.
3. Offer bracket/legend stages (5) as optional presentation, after the agreed
   renderer boundary is clear.
4. Discuss ownership mode (6) and scope filters (7) independently. They offer more
   substantial conflict reduction but also change how work is organised on screen.
5. Offer parent-root navigation (8) without bundling preferred key remappings.
6. Keep native execution (9) deferred until its workflow-independent contract is
   something the maintainer actually wants.

Create one clean branch/worktree per independent proposal from current upstream.
If proposals are stacked, state the exact dependency and rebase later branches
after the prerequisite merges. Do not send a fork-wide PR or carry our cumulative
fork implementation document as an upstream design mandate.

For each proposal, record the issue link, agreed scope/defaults, upstream base,
extraction branch, prerequisite PRs, focused regression commands, full check/CI
verdict and remaining coverage gaps in a short plan under `docs/plans/` if useful.
Use the contribution and working-note links above when assigning future work,
not just this summary; refresh them first. This file is the proposal catalogue,
not a replacement for those instructions or a licence to bypass their checks.

Once a change merges upstream, integrate the upstream implementation into the
fork and remove the corresponding private implementation. Avoid leaving both
paths active. Confirm that our defaults and remaining custom behavior still work;
upstream may accept the feature with a different API or implementation.

Measure progress by the remaining semantic diff in shared hot spots such as
`src/view/forest/mod.rs`, `src/view/fitted.rs` and snapshot construction, not by
PR count. Bracket colours alone remove little maintenance work; accepted viewport,
renderer and view-boundary changes can remove much more. No proposal's acceptance
or maintenance saving is guaranteed.


Follow-up maintenance: [AGENTS.md](AGENTS.md) requires every completed change to
update an existing proposal or add an independent candidate here. This catalogue
now includes the tree/search increment tracked in [INTENDED-CHANGES.md](INTENDED-CHANGES.md).
Implementation completion does not waive any upstream reproduction, maintainer
discussion, extraction, validation or actual CI requirements above.
