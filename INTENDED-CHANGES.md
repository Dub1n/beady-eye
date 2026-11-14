# Intended changes: compact trees and passive agent activity

Status: implemented in this fork (including the 0.43.0 follow-up checklist). This document remains the agreed design and
acceptance checklist. See [the fork guide](docs/passive-activity.md) for actual
configuration and controls, and [the validation report](docs/validation-passive-activity.md)
for tested coverage and platform/source limits. Upstream screenshots and optional
write integrations do not describe this fork's default passive viewing path.

## Purpose and boundaries

Preserve beady-eye's recognisable tree layout, colours, selection, folding,
search, bead details and optional pane preview. Add targeted compact rendering
controls, scoped completed-work visibility and automatic execution correlation.
The default should remain a simple tree rather than a dashboard or Kanban board.

The viewer must acquire information without additional agent commands, prompt
instructions, AGENTS.md additions or reporting duties. It must not alter Beads
statuses, assignees, acceptance records or ownership to make its display work.
Existing workflow operations remain authoritative. Automatic acceptance, task
redispatch, recovery and gate settlement are outside this feature.

The new viewing path is read-only. Existing explicit write commands are a
separate upstream capability, not something opening this view starts. No watcher,
gate writer or agent integration requiring manual registration is enabled merely
by opening the viewer.

## Tree rows and identity

Use a three-character ASCII state marker, such as `[~]`, before the title.
Do not display bead IDs or child suffixes (such as `.1`) in normal tree rows.
Use that space for the marker and useful title text. Omit the repeated tracker
prefix entirely: the project header identifies the tracker, without a separate
prefix legend.

Full IDs remain canonical internally and appear in details. Search accepts full
IDs, shortened IDs and titles; the copy-ID command copies the complete ID.
Selection, folding and correlation use project plus full ID, never title text.
Repeated titles must not collapse distinct beads into one identity.

A dependency rendered outside its own project needs an explicit foreign-project
qualifier. A multi-project view retains project headers. Do not make otherwise
ambiguous IDs or rows indistinguishable by removing their project context.

Invented example (model labels illustrate placement, not actual assignments):

```text
arkham
  [~] Move payments to the new gateway          1/4  Sol
    [~] Implement the refund path                   Luna
    [?] Cut the live keys over
    [T] Review gateway boundaries                   Sol
    [x] Pin the client version
```

## Width, indentation and fonts

- Truncate tree rows; never wrap one bead across multiple list rows.
- Fit using terminal display-cell widths, respecting Unicode and styled text.
- Reduce optional fields and padding before sacrificing essential title space.
  At narrow widths, the state and title take precedence over model, priority,
  progress and badges; every omitted field remains accessible in details.
- Details must remain reachable at every usable width. Use the available pane
  width on narrow terminals instead of refusing details below a fixed threshold.
  Prose in details may wrap and scroll; the single-row rule applies to the tree.
- Make hierarchy indentation configurable, with a nominal two-cell compact
  default. Keep connectors, selection and fold markers coherent with the chosen
  spacing. Space can be recovered without changing the parent-child structure.
- Preserve the existing Unicode connector style by default, with a complete
  ASCII alternative that requires neither an icon font nor unusual glyphs.
  State markers are ASCII in both modes; colour is supplementary information.
- Do not add a new minimum-width barrier for viewing, navigation or details.
  Extremely small panes should degrade predictably without drawing out of bounds.
- Keep pane preview optional and toggleable so it need not consume list height.

## Views and completed work

Provide three views, with distinct scope and execution filtering:

1. **Current work (default):** all roots with at least one open, in-progress,
   blocked or hooked/prepared bead anywhere beneath them, including the root
   itself. Preserve ancestors needed to connect matching descendants. An active
   descendant beneath a closed parent must remain reachable. Other nonterminal
   statuses must receive an explicit policy and remain discoverable, rather than
   silently vanishing as the tracker gains statuses.
2. **Activity:** executing work, prepared work, blocked items needing attention,
   and finished work awaiting review or acceptance, with ancestry for context.
   This is not simply a list of panes currently marked working. Unknown activity
   is distinguishable from confirmed inactivity.
3. **History:** searchable closed work across the project, including roots absent
   from the default view.

A hotkey toggles closed beads within the current scope. Relevant closed children
can be folded into counts, preserving beady-eye's compact completed-run behaviour.
History provides access to unrelated closed roots; toggling closed children does
not unexpectedly replace a focused scope with every historical root.

Hide narrowly identified disposable contract-test records by default, with a
visible hidden count and an override. Identify them using a configurable,
conservative combination of provenance/metadata and known fixture conventions;
never hide all titles containing “fixture”. Legitimate product validation work
can involve fixtures. Historical identification must not require mutating old
beads. Isolating future tests in a disposable tracker is separate maintenance.

## Navigation and refresh stability

- Up/down: highlight the preceding/next visible row.
- Right: expand a collapsed branch; on an expanded branch, select its first child.
- Left: collapse an expanded branch; otherwise select its parent.
- Ctrl+Space: set the selected root separately and idempotently. F retains the
  existing focus/restore action; Home restores the default ownership forest.
- Home or H: restore the default ownership forest containing unfinished work.
- Backspace: reveal the parent root level while retaining selected bead and filters.
- Space and Enter: open bead details, with the same follow/focus action in details.
- Keep the ready/unblocking view and dependency relations available. Use a
  separate dependency graph rather than duplicating shared blockers in the
  default ownership hierarchy. Each project-qualified bead appears once there.
- Provide discoverable keys for the completed toggle, view switching, search,
  full-ID copying, pane focus and optional preview. Resolve collisions with
  upstream bindings and update help together; unspecified key letters are not
  fixed by this document.

Arrows follow conventional tree navigation. Root selection is an independent
shortcut, and project headers and summaries keep defined fold/navigation actions.

Preserve selected bead, explicit root, fold state and scroll position across
refreshes where possible. A bead closing or its worker finishing must not remove
a tree the user is inspecting or automatically move focus. Retain such context
until explicit navigation/view reset; Home recomputes the default filter. If a
bead disappears or becomes unreadable, show that fact and offer a predictable
selection fallback rather than silently jumping elsewhere.

## Display states versus persistent statuses

These markers are derived viewer states, not new Beads database statuses.
Details always expose the stored status and the evidence behind the marker.

| Marker | Meaning | Required evidence |
| --- | --- | --- |
| `[ ]` | Open, not started | Stored open status |
| `[~]` | Working | In-progress bead and current execution evidence |
| `[<]` | Prepared/reserved | Stored hooked status; execution not yet confirmed |
| `[?]` | Blocked | Stored blocked status |
| `[T]` | Worker finished; review or validation pending | Matching current task ended; outcome qualifications remain visible |
| `[A]` | Awaiting acceptance | Explicit workflow evidence that the result is ready for acceptance |
| `[F]` | Execution failed | Matching current execution failed |
| `[-]` | Execution cancelled | Matching current execution was cancelled |
| `[x]` | Bead closed | Stored closed status |
| `[!]` | Conflicting state or evidence requiring attention | A concrete detected inconsistency, explained in details |

Priority is a separate field, never the meaning of `[!]`. `[D]` for documentation
is reserved for possible later work; do not infer it now. Forwarded and
implemented-broken are not initial states because current inputs do not reliably
establish them.

### Precedence and qualifications

Closed beads stay `[x]`. Closure alone does not establish functional validation
or real-backend proof. Show acceptance evidence separately; a suspicious closed
record can carry an additional conflict warning without losing its closed marker.

Open, hooked and blocked beads retain their persistent-state marker. Execution
facts appear beside them or in details. Contradictory evidence may add `[!]` as a
warning; it must not silently rewrite their stored meaning.

For in-progress beads, refine the marker using the matching current attempt.
Use `[~]` plus a compact `?` qualifier on the right (explained as activity unknown
in details) when liveness is not established. Do not equate a missing runtime file or stale observation with
working, failed or cancelled execution.

A completed task proves execution ended, not that it succeeded or is acceptable.
Use `[T]` with “outcome unverified” where necessary. Use `[A]` only when the
existing workflow establishes readiness, such as passing applicable checks and
an explicit review-ready transition. Define that predicate in the adapter;
absence of acceptance is not itself readiness. If present records cannot prove
it, retain `[T]`. A failed check remains visible even if the native task ended
normally. Cancellation describes execution, not necessarily a dropped task.

A detected conflict must explain the incompatible facts and their provenance.
An unavailable source is unknown, not automatically conflicting evidence.

## Parent beads, workers and progress

A parent can have its own coordinator/worker while children have separate
workers. Show parent activity independently of child completion progress; where
space permits, both the progress count and model appear on its row.

A parent worker does not own every child. Child execution does not establish
that the parent itself is executing. Parent status remains independent of child
status: a closed parent with unfinished descendants remains inspectable and can
carry a warning.

Define and document progress denominators consistently, retaining upstream
semantics where suitable. Explain in details what is counted, whether descendants
or direct children, and how shared/dependency nodes are deduplicated. Progress
counts describe recorded completion, not verified product acceptance.

Replace repetitive short activity labels with the model, preferably short labels
such as Luna or Sol when unambiguous. Other models retain intelligible names.
Model is not unique worker identity: details include worker name/type, task ID,
child session, coordinator and attempt. Several same-model workers must remain
distinguishable when expanded. Prefer the effective execution model over merely
requested configuration; unavailable model data stays unknown.

## Passive information acquisition

### Sources and authority

- **Beads:** persistent identity, hierarchy, dependencies, status, priority,
  assignee, attempt/dispatch metadata, check records and acceptance records.
- **OmO native task records:** task identity, parent/root and child sessions,
  worker name/type, effective model, runtime outcome and execution timestamps.
- **Herdr:** actual pane availability, agent/pane state, focus operations and
  optional preview. A worker need not have a separate pane.

Existing dispatch metadata can contain a dispatch-time `running` value long
after native execution has completed. Treat it as a receipt, not a heartbeat.
Native completion does not close the bead or grant acceptance.

### Correlation

Use project identity plus bead ID plus current attempt as the base. Resolve the
existing dispatch task ID to its native task record, then validate coordinator,
project and session consistency where available. A previous attempt's recent
completion must not supersede a current attempt. Validate dispatch attempt IDs
before using task outcomes.

Support one coordinator owning multiple beads and workers executing without
separate panes. Do not force these into upstream's one-bead-per-pane claim model.
Link a worker to a pane only with reliable session identity; sharing a working
directory, title, model or coordinator does not prove worker-pane identity.

For multiple current workers, retain individual execution records and aggregate
without hiding failures or pending work. Define deterministic precedence for
mixed outcomes; ambiguous ownership produces a qualified state or conflict,
never an arbitrary winner. Preserve provenance for each decision.

### Adapter boundary

Keep workflow-specific metadata interpretation in an optional OmO adapter,
configured for the owning project/runtime. Generic collection/model/rendering
consume normalised activity evidence and remain useful with plain Beads alone.
Do not hardcode a private deployment's paths, project names or metadata schema
into generic tree rendering.

The adapter can read existing fields such as `qrclipWork.attempt` and
`qrclipDispatch` when configured for that convention. These names describe an
existing integration contract, not a requirement imposed on every tracker.
Version adapter inputs, validate schemas and degrade explicitly on unsupported
runtime versions. Native files are implementation details unless backed by a
stable API; prefer a supported read interface when one exists.

### Refresh, optional hooks and failure handling

Use bounded reads and cache parsed results; read each tracker/task source once
per relevant refresh rather than spawning one process per displayed row. Observe
file updates or runtime events where practical, with bounded polling fallback.
Expose source freshness and last successful observation. Recover from partial
writes, removed task files, restarts and unreachable trackers while clearly
marking cached information as last known.

Existing native task and session records should provide the initial integration.
Only if a necessary correlation cannot be acquired passively may a small runtime
hook publish it automatically to a local viewer channel. Such a hook adds no
agent instructions, calls, acceptance decisions or tracker writes. If unavailable,
viewing still works with reduced activity information. Viewer failures must not
block dispatch, acceptance or ordinary work.

Any cache is derived, disposable data, not another authoritative task ledger.
Keep it outside the tracker. Read only the configured local sources, avoid
unbounded transcript scanning and do not send task/session content externally.
For preview, identify whether output belongs to the worker or its coordinator;
never present coordinator output as a worker's private execution stream.

## Packaging and implementation outline

Retain installation as a Herdr plugin. Fork builds must use their own repository,
release assets and matching manifest; do not accidentally install upstream's
unmodified binary. Preserve standalone use and plain-Beads operation.

Suggested implementation order:

1. Define normalised evidence, derived-state rules and configurable source mapping.
2. Add the passive OmO reader and validate current-attempt correlation.
3. Render bracket markers, model labels and parent activity plus progress.
4. Add ID-free rows, width handling, adjustable indentation and ASCII connectors.
5. Implement the three views, completed toggle and focus/fold navigation.
6. Reconcile help, configuration reference, design documentation and packaging.

## Acceptance criteria

- No extra agent commands, prompt additions or reporting steps are required.
- Opening, refreshing and navigating the view issue no tracker mutations.
- Plain Beads works without OmO or Herdr, with explicit activity limitations.
- An old dispatch receipt cannot make a completed worker appear to be executing.
- Worker completion, successful checks, acceptance and bead closure remain distinct.
- Parent and child workers can coexist; one coordinator can own multiple beads.
- Current-attempt matching rejects stale receipts, cross-project collisions and
  ambiguous worker/pane joins; multiple workers and missing files are covered.
- All specified markers, precedence rules, unknown cases and conflict explanations
  are exercised with invented inputs, including completed tasks with failed checks.
- At 30, 40, 60 and 80 columns, deep trees truncate predictably and navigation,
  selection and scrollable details remain usable; test smaller widths for bounds.
- ASCII rendering needs no special font. Full IDs remain searchable and copyable.
- Root focusing, parent reveal, folding, completed toggling and Home behave as
  specified, including live closure while a branch is selected.
- Current work includes blocked and hooked descendants; History exposes old closed
  roots. Disposable fixture filtering is narrow, reversible and visibly counted.
- Refresh preserves inspection context and shows stale/unavailable sources.
- Validate the built plugin in Herdr as well as renderer/model tests. A passing
  source test alone is not evidence that the installed plugin runs the fork.

All committed examples and test fixtures must be invented, in accordance with
[CONTRIBUTING.md](CONTRIBUTING.md). Do not publish local task captures, sessions,
paths, private project descriptions or logs as implementation fixtures.

## Tree interaction and search follow-up

The following checklist tracks the next increment; earlier implemented sections
remain the baseline. Configuration examples use invented projects.

- [x] Root indentation: `never`, `single-tree`, `always` modes for suppressing
  the project-to-bead indent while preserving nested connector alignment.
- [x] Scroll keybinding help with Up/Down without closing it.
- [x] General opt-in regex title exclusions; suppress excluded placeholders
  independently of completed visibility, retain explicit exclusion override.
- [x] Hide completed work consistently in trees without live agents.
- [x] Search: default jump mode plus optional live filter, Up/Down while editing,
  Ctrl+F alias, status-prefix OR matching combined with title text by AND.
- [x] Remove redundant directory-scope explanatory row from compact views.
- [x] Keep concise selected-status legend at the bottom of the bead band,
  sharing its row with bottom overflow dots.
- [x] Mouse (revised below): Alt+click sets root; double-click opens details;
  Ctrl+click goes up one root level and selects
  the clicked bead; click an already selected parent toggles its fold.
- [x] Sticky project headers with counts and overflow dots: configurable active
  header or all hidden headers at top/bottom, respecting tiny terminal capacity.
- [x] Compact right labels: unknown activity `?`, separator only after a model,
  single spaces and completion fraction last.
- [x] Configurable minimum preview height, bounded by available terminal space.
  Optional delimiter dragging only if it fits the existing event architecture.

## Root indentation consistency follow-up

- [x] Apply hidden project-root indentation consistently to project groups,
  unclaimed panes, unread roots, notes and completed runs, retaining group fold
  controls and nested structure. Cover always and single-tree modes.
- [x] Name the setting `hide_root_indent` so `always` clearly means always hide;
  accept the old `root_indent` spelling without changing its meaning.

## Session identity and detail markers

- [x] Resolve missing model identity from the exact worker session, or the
  coordinator session for explicitly direct work. Bound/cache log reads, verify
  session IDs, preserve attempt correlation and never infer liveness/acceptance
  merely from a model record. Report missing or ambiguous evidence honestly.
- [x] Use configured fork status markers and bracket colours in detail headers
  and all related-bead sections, including current correlated activity when the
  referenced bead is available, with identical drawing/click geometry.

Ownership is non-exclusive: a coordinator or worker may own multiple beads and
must appear on each current explicit association. Reusing a task/session across
beads is not itself conflicting evidence. Native explicit bead/attempt mismatch
still requires attention. A known coordinator may be displayed as `model (coord)`
when the delegated worker model is unavailable; it must not be called the worker.

## Stable grouping, fold hints and persistent filters

- [x] Keep completed trees in their existing section while inspecting hidden work;
  do not promote a hidden tree merely because its row was selected.
- [x] Avoid preview ellipses caused solely by captured trailing blank padding.
- [x] Centre group disclosure arrows on tree verticals, including the project
  heading; show a collapsed bead arrow after its status without a new left column.
- [x] Keep nonblank active filters visible after leaving search and restore the
  exact saved query cursor when search is reopened. Whitespace alone is no filter.

## Fold-hint placement refinement

- [x] Keep collapsed arrows in the branch for beads with a horizontal connector.
  Only branchless beads use `[ ]▸ Title`, consuming an existing separator cell so
  titles stay aligned with expanded rows. Preserve ASCII and legacy layouts.

## Completed folds and pointer actions

- [x] Explicit fold choices override automatic expansion of preserved completed
  selections, consistently in rendering and row counts, including refreshes.
- [x] Double-click opens the clicked bead's details; Alt+click sets it as root.
  Keep Ctrl+click for parent-root navigation and Ctrl+Space as a keyboard fallback.

## Bead-first live agent links

- [x] Recover an omitted OmO session ID from Herdr's exact foreground process
  argv, with bounded lookups and strict pane/application/identity validation.
- [x] Join current native worker/direct/coordinator associations to matching live
  panes within the same project. Ownership is non-exclusive; preserve conflicts
  and distinguish a live coordinator from an executing delegated worker.
- [x] Show a compact live-agent indicator and role/state beside the bead's model;
  expose pane/session/provenance in details and preview/focus from the bead.
  Linked panes should no longer appear as unclaimed. Count a shared live pane once.
- [x] Cover missing/ambiguous/stale/conflicting evidence, cross-project IDs,
  multiple-bead ownership, UI state and end-to-end passive collection in tests.
