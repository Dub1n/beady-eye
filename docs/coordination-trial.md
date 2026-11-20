# Observing coordinated work

The optional recorder captures what a selected viewer pane displays alongside
separately collected, project-scoped work data. It is intended to help an
operator compare responsibility, worker identity and recorded execution at a
particular point in time. It does not dispatch work, transfer ownership, run
checks, or establish acceptance.

The recorder is opt-in. It reads the selected pane and makes bounded reads
from the configured viewer; it does not navigate the pane, send input, or
control workers. A pane sample and a data read happen separately, so they may
straddle a change. Treat missing, stale, partial and conflicting observations
as unknown rather than filling gaps by inference.

## Record a short observation

Use the launcher help to see the supported arguments:

```sh
python3 tools/observe-work-pane.py --help
```

Provide the verified viewer binary and its independently obtained SHA-256,
the project name, the full bead ID, and a private output directory. Set the
explicit viewer configuration when one is in use. Keep recorded output outside
the checkout, restrict access to it, and inspect it locally before sharing any
derived finding.

Each observation pairs visible terminal text with a separate structured
snapshot. The report records the stop reason and whether requested reads
completed. A successful process exit without a paired observation is not
evidence that the work was visible. Visible text can include sensitive content
shown in the viewer, so disable previews that should not be recorded.

## Capture a later point or summarize a run

For a later, one-shot read from the same verified viewer generation, consult:

```sh
python3 tools/work_sweep_capture.py --help
```

The command requires the original run manifest and its expected digest, plus a
project-qualified target and a new output file. It does not switch the viewer
to that target. Keep the visible pane target and the queried target distinct
when interpreting a capture.

To summarize an already completed recorder run without contacting a viewer or
tracker:

```sh
python3 tools/work_trial_summary.py PRIVATE_RUN_DIRECTORY
```

The summary reads the retained manifest, observations and report. Compare
changes in structured work data with changes in visible text; a freshness
indicator can change even when assignment does not. Partial reads and
unchanged references to earlier retained text must remain explicit.

## Schedule a bounded sweep

The sweep driver has offline setup and replay operations as well as a live
sampling mode. Check its command help before use:

```sh
python3 tools/work_sweep.py --help
python3 tools/work_sweep.py dry-run --help
python3 tools/work_sweep.py run --help
```

Use a new private state directory and an owner-maintained mapping that binds
the project, viewer session, task data and requested checkpoints. Live
sampling may read the viewer and scoped work data. Do not add tracker polls
solely to populate a mapping. A slot allocation is not a successful
observation: review persisted results for missed, partial and interrupted
reads.

Run these commands from the source checkout or the root of a
[verified local distribution](local-work-distribution.md). The bundle
contains the tools, not a recording, configuration, or existing run.

Keep raw observations private. Share concise findings that identify the
relevant source and uncertainty without publishing captured terminal content,
private filesystem locations, or operational identifiers. The viewer and
recorder are observational aids; authoritative work status, check results and
acceptance remain with their respective source records.
