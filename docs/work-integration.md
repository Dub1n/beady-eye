# Beads work integration contract, version 1

The portable work package owns the evaluator and Beads transitions. Its CLI
and the OmO work adapter use the evaluator before acting. The observer and
bdi use a read decision from the same evaluator for projects using this
integration. A viewer process is optional.

## Policy source and precedence

The user supplies `work-policy.json` under `~/.config/beady-eye/`.
Use the user's installed configuration path, with explicit trusted overrides
for disposable profiles. A repository setting, session prompt, tool input,
current directory or Beads record cannot select the policy file. Open the
policy as a bounded regular file in the trusted configuration directory.
Publish edits atomically. A missing, invalid, ambiguous or unsupported policy
disables the integration and reports an actionable reason.

```json
{
  "version": 1,
  "scope": "selected-directories",
  "defaultLevel": "observation",
  "directories": [
    { "root": "/srv/work" },
    { "root": "/srv/work/team", "level": "management" },
    { "root": "/srv/work/team/archive", "level": "disabled" }
  ],
  "projects": [
    { "root": "/srv/work/team/orchard", "level": "delegation" }
  ]
}
```

Scope is `all-local`, `selected-directories` or `explicit-projects`. The first
applies `defaultLevel` to eligible existing projects. The second applies it
within listed directory roots. A directory entry without `level` inherits the
default. An exact project entry requires a level.
Under `explicit-projects` only an exact project entry can grant permission.
An exact project entry takes precedence over eligible directory entries,
followed by the deepest component-wise directory match and then the applicable
default. Paths such as `/srv/workbench` fall outside `/srv/work`. Explicit
disable wins at its precedence level. Duplicate or invalid entries fail
closed. A project may request a lower capability through trusted adapter
preferences, within the user's grant. Project source has no grant authority.

An exact `projects` entry can opt into `"allowWslEvidenceChecks": true`.
It is off by default, is not inherited from directories or defaults, and
does not grant management or delegation. On WSL it enables only this form
of `check`, for the direct preparing coordinator of a non-fixture item
with a blocking dependency:

```json
{
  "id": "orchard-42",
  "attempt": "11111111-1111-4111-8111-111111111111",
  "kind": "functional",
  "retainedEvidence": [
    { "path": "build/manifest.json", "sha256": "<64 lowercase hex digits>", "completeManifest": true },
    { "path": "build/client.bin", "sha256": "<64 lowercase hex digits>" }
  ]
}
```

The writer reads one to eight unaliased regular files inside the project
(32 MiB total), and checks `status: "complete"` when requested for a JSON
manifest (64 KiB max). The receipt records that no check command ran.
Acceptance and downstream checks revalidate the files, receipt and
prerequisites. This verifies retained bytes, not a fresh application or
platform run. Commands, cleanup and writable outputs are not accepted in
this form. Arbitrary protected executable checks still fail closed on WSL;
the separate per-attempt nonvisual first-case exception is unchanged.

### Trusted fixtures versus protected checks

An administrator can additionally apply a permanent ext4 immutable
seal to accepted evidence and its hash manifest. This is a file-specific
requirement, not a general sandbox and not a grant to run arbitrary
commands. Without an external archive root the writer must validate the
actual project paths. Never give the fixture
or its cleanup the privilege used to apply the seal. The
[dummy archive procedure](evidence-seal-test.md) separates administrator
setup from unprivileged verification and records what the test does not
establish.

The operator requests this stricter mode in the **pinned fixture
descriptor**, not in the bead or the caller's `check` input:

```json
"evidenceSeal": {"manifest": "/var/lib/orchard-proof/manifest.json"}
```

The administrator-owned manifest identifies its canonical project and the
checkout-relative names and SHA-256 digests of its evidence. Calculate those
digests from the accepted originals. Applying `+i` to a manifest describing
different files is not a substitute for sealing the originals. Changing a
descriptor requires a fresh descriptor pin. No checkout contents,
permissions, operator accounts or seals are changed by inspecting a grant.

For a writable checkout, set `archiveRoot` alongside `manifest` in the
operator-pinned descriptor:

```json
"evidenceSeal": {
  "archiveRoot": "/var/lib/orchard-archive/snapshot",
  "manifest": "/var/lib/orchard-archive/manifest.json"
}
```

Stage accepted files under `archiveRoot` using their recorded relative
paths. For example, an accepted `.beads/checks/run-1/manifest.json`
maps to `/var/lib/orchard-archive/snapshot/.beads/checks/run-1/manifest.json`.
The seal manifest's v1 `project` field is the canonical **sealed file
root** (here, `/var/lib/orchard-archive/snapshot`). The actual checkout
is still selected by its exact operator policy grant. These are different
roles: the grant selects the archive, Beads supplies the expected hashes,
and the verifier reads the sealed files. An unrecorded or mismatched
digest is not authorized by being present in the archive manifest.

The archive must be disjoint from the checkout and meet the same ext4,
root-ownership, immutable-file and protected-path requirements as before.
Only archived copies are OS-protected; the checkout and `.beads` remain
writable, and existing checkout freshness checks still apply. Nothing
copies or restores evidence automatically. With no `archiveRoot`, the
original in-place seal contract is unchanged.

For an explicitly trusted fixture, the author is responsible for writing
only the run's fresh outputs and cleaning up only the resources it created.
The writer detects changes to the accepted evidence covered by the check
and fails the result if evidence is missing or changed after cleanup.
Detection neither prevents deletion nor restores lost bytes. It is not
protection against a malicious fixture running with the user's authority.

This contract applies only when the operator has approved a named fixture
for the exact project and the coordinator selects it explicitly. A protected
check never falls back to trusted execution when isolation is unavailable.
The retained-evidence form above is different again: it reads existing
files and does not execute a fixture. None of these modes accepts a bead
on the coordinator's behalf.

The grant names an operator-controlled descriptor outside the checkout
and pins its bytes, not just its filename. The descriptor separately pins
the bytes of the primary executable, the cleanup executable and the cleanup
verifier, along with relevant project inputs. The request supplies a fixture
ID, not executable paths, arguments, environment or a replacement cleanup.
A pinned launcher is not by itself a pin on a script or Windows helper
that launcher interprets; the descriptor must cover the actual inputs
used by the run.

Example exact project entry (illustrative paths and hashes):

```json
{
  "root": "/srv/work/orchard",
  "level": "management",
  "trustedFixtures": {
    "notification-cleanup": {
      "descriptor": "/srv/operator/fixtures/orchard-notification.json",
      "sha256": "<SHA-256 of that descriptor file>"
    }
  }
}
```

Keep the policy under operator control. Removing the fixture ID from
the grant denies subsequent selections; it does not cancel an already
running check. Remove new policy keys before switching back to a writer
that predates them, since older writers reject unrecognized policy fields.

The descriptor's primary action is at the top level (`executable`,
`sha256`, `args`); `cleanup` and `verifyCleanup` each have those same
three fields. `version: 1`, `env` and `projectInputs` complete the
descriptor. An input pin has a checkout-relative `path` and a `sha256`.
Keep the cleanup verifier independent of the cleanup command: it must
inspect the resulting state, not just repeat the command or accept its
exit code. Seeing an approved ID in `policy` means it can be selected;
it is not proof that its pinned files still match or that the fixture ran.

The evaluator returns the canonical project identity, effective level and
decision source, with a bounded reason on unavailable or denied decisions.
Expose this through the work CLI's versioned JSON policy inspection, including
with the viewer closed. Let bdi invoke the same optional, user-installed
evaluator by an explicit trusted executable path for opted-in projects, and
show its decision and source. Never run an evaluator from a viewed checkout.
If configured evaluation fails, withhold that project's integration
observations. Existing bdi reads configured without the integrated work
package are outside this policy and remain read-only with respect to work
authority. An editor can persist the policy atomically using the same format.

## Project identity

Resolve the live session cwd and configured roots through filesystem realpath.
A symlink alias resolves to its target and cannot inherit permission from an
unrelated lexical parent. Find the nearest project boundary, stopping at a
nearer Git checkout or worktree even when it has no Beads store. For a non-Git
directory, use the nearest existing Beads root. Accept only the supported local
store at that root. With Beads 1.3.4, `bd --sandbox where --json` describes
the active workspace and database separately. Start it only after finding a
real local `.beads` directory. Use the same root and controlled locator
environment for this probe and subsequent calls. Reject redirected, symlinked,
external or ancestor-fallback tracker locations. Storage and Git routing
overrides from the process environment do not select a tracker for this
integration. A linked worktree is a
different project only when it has its own independent eligible store. Shared
Beads state between worktrees is unsupported in initial integration. Discovery
may inspect local markers but cannot initialize or repair a store or start a
tracker service. Surface unavailable stores without falling back.

Supported Beads 1.3.4 stores are local embedded Dolt and an already running,
project-owned classic Dolt server on Linux. The server route requires
numeric loopback, the default project data directory, a matching stored
project identity, and readable process ownership evidence. The policy checks
the listening socket, process generation and the database lock under that
directory. It rejects external, shared, proxied and redirected routes.
Serialize server lifecycle changes with work. The adapter checks identity
before each call, and `bd` opens its own connection afterward.

Use the canonical root as the stable local identifier. Bind an admitted
operation to the resolved root and local store instance and verify the
binding at privileged asynchronous boundaries. A path or store replacement
invalidates an in-flight binding, even when path text or issue prefix matches.
Moving a project requires review of root-based overrides and a fresh runtime
binding. Under `all-local`, a moved eligible project can receive the default
for a new session. Never transfer an old session's authority to it by name.

Every lookup, marker use, tracker call and recovery uses this project identity
and the full issue ID. Treat a resolved partial Beads ID as invalid when the
returned full ID differs. Determine the project from a trusted caller context
and store, never from marker text, a nickname or the adapter module's path.
When registering both the observer and bdi, bind the user-configured bdi
project key to the same canonical root and canonical native task directory.
`[omo.<project>]` names an existing configured project. Its `task_directory`
is an explicit native store path scoped to that project. Its
`observation_directory` is a private output path, disjoint across projects.
Avoid deriving either from a short ID or reporting a match with unresolved
scope.

## Operations and reload

| Required level | Operations |
| --- | --- |
| `disabled` | Diagnose policy and project binding locally. No tracker or native work reads, tool writes or telemetry. |
| `observation` | Read `show`, `packet`, `limits`, and independently permitted native observations. |
| `management` | Additionally `create`, `edit`, `note`, direct `prepare`, `check`, `accept` and explicit `recover`, subject to actor, state and proof checks. |
| `delegation` | Additionally delegate `prepare`, prepared dispatch reservation and its matching result publication on the supported native route. |

Read current policy before each public work operation and guarded admission.
A known guarded session whose permission is reduced blocks new guarded
dispatches even when previously prepared. A revoked operation can only finish
already admitted result bookkeeping or mandatory cleanup using its captured
project, session, attempt and exact reservation. Never grant a new operation
through that captured decision. If the store or session binding changes,
retain the incomplete operation for explicit recovery. No policy edit
implicitly cancels workers or closes work. A later recorder callback cannot
adopt a newly prepared owner. New checks and acceptance always require a fresh
decision. Stop observation on a denied read, remove only the owned published
frame where possible and let existing telemetry expire on other readers.

Use one work tool registration per participating OmO session. Confirm the
project at session start and at dispatch, including in actual children. The
initial supported route is native Tasks on the host-backed runtime verified
with OmO 5.1.77. The guard covers routed task calls, including eval task calls
where the native runtime delivers the same hook. Coverage depends on the
actual participating hosts. The policy applies to calls routed through this
package. Other tools, direct user shell use and untested backends have their
own authority boundaries. The viewer never grants authority.

## Work and observation records

Preserve `metadata.qrclipWork` version 1, `metadata.qrclipDispatch`, the
`QRCLIP_WORK` marker and existing check environment variables in the initial
transfer. Install only one writer for a project. A marker identifies the
prepared full ID and attempt within the actual caller's project. Only the
preparing actor can reserve it. The work package owns guarded Beads updates
and their uniquely reserved transitions.

| Record | Writer and interpretation |
| --- | --- |
| `qrclipWork.attempt` | Work package. Attempt ID, coordinator session, mode, preparation time, source fingerprints and prerequisite receipts. Beads status and assignee retain ownership and transition reservations. |
| `qrclipDispatch` | Work package called by the work adapter. Attempt, tool call, result digest, outcome and native task ID where known. Optional child identity is historical receipt data. A dispatch receipt records admission or error. |
| `qrclip-beads-dispatch-start/result` | Work adapter. Ordered reservations for a tool call, with result failures. Pair them with the actual native tool result and parent session. Observer consumes these records and never edits them. |
| Task/session state | Native OmO. Qualify current task and child by project, native store, parent, creation and current identity or generation. A task ID and run epoch can survive a child replacement. |
| Version 1 observation frames | Observer. Bounded, scoped, expiring snapshots and admissions. A result may arrive before its receipt callback finishes, so use the existing bounded correlation window. Missing, conflicting, stale and unsupported evidence remains unknown. |
| `qrclipWork.checked`, acceptance and recovery | Work package. Bind executed receipt, paths, hashes, prerequisites and cleanup to the attempt. The preparing actor reviews and accepts unchanged passing evidence. Existing approved fixture recovery and immutable artifact rules still apply. |

The observer must load before prospective admission. A childless historic
receipt plus a plausible task record leaves child identity unknown. The host
route uses public hooks and read-only authenticated current-state reads.
Private `_emit` instrumentation is outside this route. A detached PID
fallback also requires Linux PID namespace and process start identity.
Replayed frames retain their original observation time.

Keep assignment, presence, execution, outcome, check and acceptance separate.
Parentage, dependency and native ancestry are independent relations. The
ownership tree projects the same complete dependency snapshot used by
details, dependencies and JSON. Unsupported versions provide no work or
worker inference.

## Gate ownership

Step 3 owns the policy decision matrix, no-store behavior, portable CLI,
tracker and report/receipt regressions. Include nested roots, aliases,
worktree store separation and both kinds of deadline. Step 4 owns package
activation, same evaluator wiring, policy reload and revocation at the native
hook, project-scoped observer and reader integration, and the disposable
configuration template. Step 5 owns a real combined host run with two
configured projects, same-looking IDs, a rejected cross-project or missing
marker and actual nested work, passive reading and acceptance. Step 6 owns
synchronized stale result/owner rejection and bounded native replacement.
