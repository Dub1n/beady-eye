# Proposed changes: passive evidence and reliable work records

## Investigation log — 2026-11-14

The fork checkout begins at `df372b5` (0.47.0), equal to its locally recorded
`origin/main`. This proposal and `tmp/orchestrator-evidence-plan.md` were
untracked at the start and must be preserved. The existing native adapter reads
the current receipt's task file and rejects an explicit child-session mismatch,
but only permits stream liveness when both the receipt and task record contain
the same child session. The QR-Clip hook currently passes a native task ID to
the receipt writer without a child session; the writer supports that field.
Investigation of durable-session replacement and the identity contract is ongoing.
Local remote-tracking state is not a fresh network verification of the remote.

The fork remote's `main` was subsequently verified at the same commit. A fresh
read-only Beads query returned 41 in-progress rows: 13 direct attempts and 28
delegated receipts, none of the latter with `childSession`. These are dated
counts, not evidence of execution. The QR-Clip checkout already has extensive
uncommitted work, including the adapter and its tests; preserve it.

The installed OmO 5.1.69 result exposes a task ID and run epoch, but not a child
session. The task file can change its child session on replacement. Native task
IDs are store-scoped and time/counter-derived, not globally unique. A receipt
is an attempt-to-task edge; the file supplies task-to-parent and task-to-child
edges, and an authenticated current host can independently establish presence.
Optional native project, bead and attempt fields cannot be treated as present.
An explicit differing child remains a conflict. A missing child must not be
filled solely from a timestamp or a conversational claim. Investigation is
continuing on whether older receipts contain sufficient independent evidence
to rule out task ID reuse. A run epoch helps future records only if its precise
scope, replacement and reuse semantics establish the intended binding.

Of the 28 current receipts, 13 referenced readable task records in the
configured store; each of those 13 named the receipt task, a matching parent,
and a child. None named a bead, project or attempt. The remaining 15 records
were unavailable there. Those observations do not establish a live host or an
unchanged dispatch-time child. Native tasks can retain their ID while their
durable child and run change; creation-time windows do not identify the original
child. The viewer therefore keeps the explicit child requirement for live
promotion. A future automatic dispatch-time publication needs a supported,
versioned way to obtain and bind that child and run from the actual native
store; blindly persisting a lookup or `run_epoch` would introduce a stale pin.
This leaves existing childless receipts unable to obtain stream liveness.

The installed task extension exports a store reader, but its effective custom or
legacy state directory is private to the native component; its legacy resolver
can itself write an adoption marker. The supported `task_output` status
snapshot can name a child, but a subsequent lookup is not atomic with the
dispatch result and the snapshot does not bind a replacement-sensitive
generation. The native replacement callback can change the child without
advancing `notification.run_epoch`. Thus even equal epochs cannot prove that a
later child was the one in the dispatch result. The reliable next step is a
native provider contract returning task, child and replacement-sensitive run
identity together, including the queued or child-unavailable case. With that
contract, the existing receipt operation can publish the binding without a new
agent reporting step or watcher. It is a provider capability gap, not a request
to alter running sessions or tracker records.

Independent review also found that the old file reader could attribute a
childless receipt's native model, task outcome and readiness before the stream
gate. That path now also requires the explicit child and matching independently
recorded parent: an uncertain association must not
turn a replacement task into bead execution or acceptance evidence. The
diagnostic examines supported multi-worker receipt forms independently, while
flagging repeated or malformed identities instead of resolving them by guess.

The hook is activated only for its checkout and loaded parent session; it guards
its task calls after activation, not arbitrary native, CLI or child routes.
Preparation, dispatch, checking, acceptance and explicit recovery already use
guarded operations and distinct ownership transitions. Direct work may have
no dispatch receipt. A completed task is not a passing check or acceptance;
recovery is an operator attestation and does not stop a worker.

The previous live-host observation is no longer current: the checked runtime
registry had no live socket or creator process, and its key directory was empty.
There is no present host against which to authenticate; the missing key cannot
be diagnosed as a running-host failure. OmO documents launch-time key publication
and configured alternate key roots. Do not restart or attach to a user's pane
to make a test possible. The documented status-only subscription is neutral to
session activity and begins with a snapshot; reconnect does not replay gaps.

A separate disposable OmO 5.1.69 host was started in an isolated temporary
profile without an agent prompt or attached session. The production stream
module, compiled into a temporary harness with an invented registry and session
header, completed discovery, peer and credential checks, authentication, a
status-only subscription and its empty initial snapshot. The isolated host and
fixtures were removed. This verifies that handshake against that host, not the
user's absent host, live worker updates, reconnect, or the complete viewer path.

The existing watcher and optional Beads journal address tracker changes, not
native liveness. Journal enablement is a separate source-writing decision. File
notifications would only accelerate rereads and add replacement, overflow and
rescan handling; no measured need presently justifies them. Process-local
history is bounded and loses unobserved intervals and restart history. Persistent
history would add retention and privacy costs without reconstructing gaps, so is
deferred absent a concrete requirement. OmO's documented session messages do
contain provider usage, and a separately inspected native source checkout has a
subagent cost ledger that reconciles prior runs with either live or settled
current-run cost. That checkout is not proof of installed-binary parity, and
the viewer's current allowlisted reader does not collect those usage fields.
Neither source alone establishes a complete bead-attempt total or removes
parent/child overlap; do not estimate totals from assignments. Task and DAG
projections can contain content; their passive RPC
classification and installed-version parity remain unproven, so no ingestion is
justified yet. Historical DAG directories do not establish current use.

These are investigation-led plans, not an approved design or a claim that the
listed work is implemented. Keep the two items separately reviewable. They can
share a correlation contract, but neither should depend on the other being
finished before useful, independent work can land.

Before each investigation, refresh the actual versions, configuration and
source behavior; distinguish documentation, tests and live observations. Update
this document as facts emerge: record dated findings and their source, evidence
and limitations, alternatives considered, decisions and reasons, revised scope,
remaining questions and test cases. Change the implementation outline whenever
the investigation supports a better approach. Do not tick an item merely
because a design exists. Put completed fork changes in the appropriate entry in
[PROPOSED-PRS.md](PROPOSED-PRS.md), following its upstream contribution gate.
Never put private captures, real session identifiers, credentials, prompts or
project data in committed examples; use invented fixtures.

Shared principles: preserve ownership, live presence, execution and acceptance
as separate facts; bind claims to a project and full bead ID, a current attempt
and verified identities; expose unknown or conflicting evidence honestly. Do not
infer assignment or active work from conversational content. Read structured
model metadata where appropriate; do not require agents to perform extra
reporting solely for the viewer. Never alter a running agent, tracker or device
during investigation without authorization.

## 1. Passive watchers and evidence

**Goal.** Make current activity and recent transitions more timely and useful
without changing Beads or OmO data or requiring agents to change their work.
An independent bdi-owned cache is a possible exception to *data storage*, not a
write to either source; make its retention and failure behavior explicit.

### Investigate

- [ ] **Status stream and authentication.** The Linux adapter in
  [stream.rs](src/collect/omo/stream.rs) already uses an authenticated,
  status-only `subscribe_sessions` subscription scoped to children, with
  message mirroring disabled. OmO Native 5.1.69's installed `docs/rpc.md`
  describes this subscription as activity-neutral and documents authentication,
  snapshots and sequences. An observe-only probe on 14 November 2026 found a
  responding host advertising authentication but no matching key in the
  expected key directory. Recheck the live host, key root and supported recovery
  path without exposing credentials or restarting the user's pane. Establish
  the root cause before proposing a fix; do not bypass authentication. Synthetic
  tests passed previously, but authenticated operation against the real host has
  not been established.
- [ ] **Lifecycle and task events.** Investigate `session_lifecycle`, its run,
  child/task identity and waiting states, and `omo.task.updated` / task snapshots.
  Determine exactly which are accessible to an unattached observer, whether
  their subscriptions affect session lifetime, and how initial snapshots,
  sequence ordering, replay, versioning, disconnects and host changes work.
  Lifecycle activity can distinguish model work and tool work, but is not proof
  of work on a bead without an independently verified link. Task projections
  may include prompts, output or descriptions: allowlist the required structured
  fields, and never infer assignment from content. Starting points are the
  installed RPC docs and OmO's [task guide](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/senpi-task.md).
- [ ] **DAG events and existing history.** Investigate whether the actual
  workflow uses OmO DAG runs and whether structured, explicitly filtered task
  attachment and lifecycle events provide additional trustworthy links or
  transition history. The [DAG protocol](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/mass-ulw-protocol.md)
  describes subscriptions and history. Event lanes can also include guidance or
  prompt content; an explicit event/field allowlist is required. Check observed
  availability rather than assuming a DAG exists for every task.
- [ ] **Filesystem notifications.** Evaluate a bounded read-only directory
  watcher for native task files and session metadata as a fallback or refresh
  trigger. Account for atomic replacement, parent-directory watches, overflow,
  reconnect/rescan and platform support. A notification or recent mtime is not
  a worker heartbeat, acceptance or bead ownership proof. Compare complexity,
  latency and overhead with the existing bounded polling.
- [ ] **Beads changes and bdi watcher.** Assess whether the existing `bdi watch`
  and read-only Beads change sources can efficiently trigger refreshes. The
  Beads events journal was disabled in the inspected QR-Clip workspace on
  14 November 2026. Reading an enabled journal is passive, but enabling it
  changes Beads configuration and causes Beads to store journal rows; treat that
  as a separate opt-in outside the no-source-writes option. Investigate branch,
  replica, retention, gaps and full-resync semantics. Upstream identifies
  `bd events tail` as read-only in its [CLI source](https://github.com/gastownhall/beads/blob/main/cmd/bd/main.go).
- [ ] **Observation history and profiling.** Compare the current bounded,
  process-local [history](src/collect/omo/history.rs) with a viewer-owned,
  optionally persistent event cache. Determine retention, restart, missing
  intervals, source timestamps versus observation timestamps, and how to mark
  earlier attempts. Investigate whether native structured usage/accounting can
  be joined without double-counting parent and child sessions, or implying
  token, cost or savings estimates where the source cannot support them.

### Initial implementation outline

Prefer supported status-only subscriptions with explicit identity checks; add
lifecycle/task sources only after demonstrating observer semantics. Keep source
adapters separate, bounded and optional, and reconcile their results into the
existing evidence model. On gaps, stale identity, unavailable auth or source
failure, discard that source's live claim and retain independently valid
tracker/task evidence; never turn silence into completion. Retain no conversation
text for attribution. If notifications are useful, use them to schedule a
bounded reread with periodic reconciliation. For persistent history, use a
bdi-owned location, explicit retention and a clear representation of coverage
and lost intervals. Preserve a no-persistent-cache mode.

Validate with invented protocol and filesystem fixtures: valid and mismatched
identity, multiple workers, task replacement, ordering/gaps/reconnect, stale or
missing credentials, stalled sources, file replacement, lost events, history
retention and narrow views. Then, where available, perform a read-only live
check against the configured host and compare only evidence it can actually
establish. Report platform and live-auth coverage separately from synthetic tests.

## 2. Tool-enforced work records and bdi correlation

**Goal.** Improve work coordination and accurate bead-to-agent attribution by
making existing operations produce consistent structured records. Prefer changes
inside existing prepare/dispatch/check/accept/recover tooling over additional
manual agent steps. Preserve legitimate direct work, shared coordination,
multiple concurrent workers and explicit recovery.

### Starting evidence and investigations

- [ ] **Audit existing enforcement and its scope.** QR-Clip already has an
  adapter in [`tools/omo-beads.mjs`](../QR-Clip/tools/omo-beads.mjs) and
  [`tools/agent-work.mjs`](../QR-Clip/tools/agent-work.mjs), described by
  [`docs/AGENT-WORKFLOW.md`](../QR-Clip/docs/AGENT-WORKFLOW.md). It records
  attempts and supports prepare, dispatch, check, accept and recovery; the
  hook guards delegated work when activated for its checkout. Its source says
  child extensions are not loaded and workers should remain leaves. Verify
  activation, direct work, nested/eval routes, supported native versions,
  cached extension reloads and all bypasses before claiming universal
  enforcement. Preserve existing admission and acceptance safeguards.
- [ ] **Resolve the missing child-session link.** A read-only snapshot on
  14 November 2026 contained 39 in-progress beads with assignee and attempt;
  28 had delegated receipts and 11 were direct. The 28 receipts had attempt and
  task IDs but no `childSession`. The [dispatch hook](../QR-Clip/tools/omo-beads.mjs)
  supplies `taskId`; the [receipt writer](../QR-Clip/tools/agent-work.mjs)
  accepts `childSession`, while [bdi's current eligibility check](src/collect/omo.rs)
  requires it to match the native record. Thus those receipts cannot currently
  qualify for stream-based liveness, even if host authentication works.
  Counts are a point-in-time observation, not evidence all those beads were
  executing, and may change.
- [ ] Compare two complementary paths: automatically record a verified child
  session when the native dispatch result or task record makes it available;
  and safely derive it for existing receipts from the exact current task record,
  attempt, coordinator and authenticated host. Check task ID reuse, session
  switches, shared tasks, conflicting sources, partial publication and retries.
  Do not relax the correlation predicate merely to produce more active labels.
- [ ] **Define lifecycle and concurrency contracts.** Audit direct versus
  delegated attempts, one coordinator owning many beads, workers with multiple
  assignments, multiple workers per bead, parent beads, replacement attempts,
  cancellation, blocked/recovered work and finished work awaiting review.
  Define which operation owns each transition and how it is guarded against
  races, stale results, interrupted publication and duplicate dispatch.
  Beads' [coordination guidance](https://github.com/gastownhall/beads/blob/main/docs/multi-agent/coordination.md)
  is a starting point; verify actual installed-version behavior before relying
  on atomicity or leases. Status and assignee alone do not prove execution.
- [ ] **Acceptance and evidence.** Identify existing attempt-bound checks,
  explicit readiness and coordinator review. Separate worker completion,
  successful check, readiness for acceptance and closed/accepted work; do not
  manufacture `[A]` from a finished task or an absent failure. Examine how
  temporary status/assignee changes during guarded transitions should be shown
  without presenting them as independent work or losing their actual meaning.
- [ ] **Read-only audit before new hard guards.** Measure missing, stale,
  inconsistent and intentionally absent fields by mode and operation; report
  provenance and coverage. Check whether the missing record represents a valid
  direct or historical state before treating it as an error. Never auto-repair,
  reclaim or overwrite active work based on the viewer's inference.
- [ ] **Profiling contract.** Identify which run/session/model/timing and
  provider usage fields are actually available and how attempts link to them.
  Distinguish ownership time, observed execution, waiting and unknown coverage;
  avoid double-counting overlapping parents/children and retries. Assignment
  does not establish tokens, cost or savings.

### Initial implementation outline

First build a read-only diagnostic and invented test matrix around the existing
contracts. Fix the receipt/lookup mismatch at the narrowest reliable boundary,
preferably automatically as part of the already-existing dispatch operation;
allow bdi to use old records only where exact corroborating native identities
make that safe. Treat adapter writes and passive bdi reads as separate scopes.
Use compare-and-swap or equivalent supported guards for source mutations,
idempotent publication and explicit recovery; test actual backend guarantees.
Do not require a bead for incidental investigation, force an agent to have only
one assignment, or block emergency recovery without an agreed exception.

Expose clear diagnostics and provenance in bdi, retaining existing stored
statuses and acceptance semantics. Validate with invented tests for direct and
delegated work, missing and contradictory IDs, old attempts, shared ownership,
concurrent publication, partial failures, source restart and valid recovery;
include a real read-only snapshot comparison where possible. Before changing
QR-Clip's adapter or enabling any new write-producing feature, define the
migration, rollback and compatibility with already-running sessions. Update
this plan with findings and revise the design before implementing them.
