# Optional OmO work adapter

The adapter exposes `beads_work` in participating OmO sessions and guards
native Task admission for projects with delegation enabled. It uses the
actual session ID and the Beads store resolved from the current checkout.
It works with the bdi viewer closed.

The reviewed host target is OmO 5.1.77 and Beads 1.3.4 with an eligible
local Dolt store. Register the adapter directory once in the trusted OmO package
configuration. Keep the `packages/beads-work` library in the same pinned
tooling tree. Grant the required capability in the host user's
`~/.config/beady-eye/work-policy.json`. For a disposable profile, supply a
private inherited home. Follow the project template for QR-Clip and the
integration contract for store eligibility, policy and recovery.

The current tests exercise the real work evaluator and tracker through
invented stores and mocked native callbacks. They cover exact project and
actor binding, ordered native receipts, session and store replacement, and
policy revocation. The disposable acceptance run exercised a root, a native
host coordinator and its native host leaf with OmO 5.1.77 and Beads 1.3.4.
Both children checked their work, and their preparing sessions accepted it.
The guard refused an unprepared dispatch and a prepared marker from a second
project. bdi read both assignments through the separately registered
observer. The observer has no work-tool registration.
For installation, capability checks and rollback, see
[local work distribution](../../docs/local-work-distribution.md). The
[fixture contract](../../docs/work-integration.md#trusted-fixtures-versus-protected-checks)
distinguishes trusted execution, sealed archives and retained-hash checks.

Run the callback tests from the fork root:

```sh
node --test adapters/omo-work/test/*.test.mjs
```

The guarded hook and tool shape derive from QR-Clip's `tools/omo-beads.mjs`
and native package entry at `ad0bc9a`, rechecked against `efa80d1`. These
copies are licensed under [Apache-2.0](../../LICENSE); see the
[fork notices](../../FORK-NOTICES.md).
