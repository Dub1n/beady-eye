# Optional current-worker observer

This optional OmO package publishes bounded metadata snapshots for beady-eye's
native activity reader. It registers no agent tools, reads no conversation text,
does not query or write Beads, and does not attach to or keep sessions alive.
Install it separately from any work adapter or writer. Beady-eye remains usable
without it; absent or unsupported observations stay unknown.

## Configure

Install a separate copy for each project in OmO's existing package directory.
Copy `settings.example.json` to `settings.json` and set invented project paths:

```json
{
  "project": "orchard",
  "projectDirectory": "/work/examples/orchard",
  "taskDirectory": "/work/examples/orchard/tasks",
  "directory": "/home/example/.local/state/beady-eye/observations/orchard",
  "workPolicyExecutable": "/opt/beady-eye/bin/bdi-beads-work"
}
```

Omit `workPolicyExecutable` to keep the observer independent of work-policy
evaluation. If configured, install the evaluator outside viewed checkouts and
set the same executable path in beady-eye:

```toml
[omo.orchard]
task_directory = "/work/examples/orchard/tasks"
observation_directory = "/home/example/.local/state/beady-eye/observations/orchard"
work_policy_executable = "/opt/beady-eye/bin/bdi-beads-work"
```

The project name, canonical task directory, observation directory and policy
executable must identify the same integration on both sides. Policy denial or
an unavailable evaluator stops observer publication; beady-eye retains Beads
rows and dependency relationships and reports activity as unavailable. OmO host
launches may filter arbitrary environment variables, so use the installed
settings file rather than relying on environment-only setup.

The package can also be configured directly through
`BDI_PROJECT`, `BDI_TASK_DIRECTORY` and `BDI_OBSERVER_DIRECTORY` in hosts
that preserve those variables. `BDI_OMO_PRIVATE_VERSION=5.1.69` opts into an
OmO private `AgentSession._emit` compatibility path; leave it unset unless the
host version and ABI have been independently verified. The configured work
policy path disables this private path. New sessions must load the package
before future guarded dispatches; earlier ambiguous receipts are not inferred
from task history or conversation content.

## Evidence and limits

Admissions are accepted only when the dedicated guarded-dispatch metadata and
the actual tool result agree. Each admission is scoped by project, bead, attempt,
task, parent session, tool call and native task creation. Current worker presence
and execution come from a separate bounded baseline. The observer stores atomic
short-lived frames and bounded per-parent admission continuity files; a retained
admission can preserve settled worker identity only when the native task's run
generation still matches. It cannot establish live presence, execution,
acceptance or successful validation by itself.

Snapshots expire quickly and beady-eye checks their freshness again. Task reads,
frame counts, cache counts, callback queues and concurrency are bounded. Host
RPC requests are read-only. Missing credentials, unsupported sources, ambiguous
identities and stale frames do not become active work. A changed or removed task
revokes continuity when that removal is observed. Public coordinator presence
remains distinct from delegated execution.

The package supports public extension context, an optional version-gated
in-process identity tap, authenticated read-only host observations, and a
PID/start-time/namespace-qualified detached-process path. These source modes
have different runtime prerequisites; package tests use invented local fixtures
and do not establish compatibility with every OmO host release. Unsupported
modes remain unavailable rather than falling back to conversational
attribution.

Run the package tests from the repository root:

```sh
node --test adapters/omo-observer/test/*.test.mjs
```

The package uses only Node built-ins and adds no OmO dependency.
