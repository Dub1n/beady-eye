# Optional Beads work package

This package supplies Beads work operations and bounded command observation.
See [the integration contract](../../docs/work-integration.md) for project
identity, permissions, records and recovery. Run `node cli.mjs policy` from a
project or one of its subdirectories to inspect its effective policy. Each
result includes the canonical project, effective level and decision source.
A disabled decision includes its reason and exits successfully so a caller
can distinguish denial from a CLI failure.

The CLI reads
`~/.config/beady-eye/work-policy.json`. Use an absolute `BDI_WORK_POLICY` only
when launching the CLI with a trusted alternative user configuration.
Operations use the invoking session identity from `QRCLIP_AGENT_SESSION` or
`PI_SESSION_ID`. A management grant can prepare with `"mode": "direct"`.
The default `prepare` mode requires delegation permission. The native
adapter owns dispatch reservations and result receipts. The CLI starts no
agents and initializes no tracker. Version 1 recognizes Beads 1.3.4 local
embedded Dolt stores and qualifying project-owned loopback Dolt servers
on Linux. See the integration contract for server requirements.

An exact project entry in the trusted policy may set
`"allowWslEvidenceChecks": true`. This allows only the built-in read-only
`check` form on WSL. It does not lift the WSL block on protected executable
checks or cleanup. See the [policy and retained-evidence contract](../../docs/work-integration.md#policy-source-and-precedence).

For executable checks, an exact project may instead approve a **named trusted
fixture**. Its pinned descriptor defines the command, cleanup and cleanup
verifier; the request supplies only its ID. Detection-only checks fail on
evidence damage but cannot prevent or repair it. To require file protection,
set `evidenceSeal` in the descriptor and use a compatible writer. Set
`evidenceSeal.archiveRoot` to verify root-owned immutable archive copies
against hashes recorded in accepted Beads proofs without freezing the
checkout. See [fixture modes](../../docs/work-integration.md#trusted-fixtures-versus-protected-checks)
and the [disposable archive test](../../docs/evidence-seal-test.md).

Run `node --test --test-concurrency=2 test/*.test.mjs` from this directory.
Tests use invented data and disposable outputs. The native OmO route has
its own integration tests.

## Source provenance

The work tracker and command dispatcher originated in Dub1n's QR-Clip
repository. Relevant revisions include `24db0b0`, `4900d1c` and `ad0bc9a`.
Local transfer selected their working source at QR-Clip HEAD `efa80d1`,
including the order-insensitive fingerprint comparison regression. The generic
observation producer and its tests come from the committed QR-Clip tree at
`efa80d1`. These imported components are distributed in this fork under
[Apache-2.0](../../LICENSE); see the [fork notices](../../FORK-NOTICES.md).
Android instrumentation is not part of this package.
