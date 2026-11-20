# QR-Clip OmO project configuration template v1

`omo.json` is a project-local routing template for the supported native OmO
host task route. It is versioned independently from the work-record contract.
It contains only the `beads-coordinator` and `beads-worker` roles and their
required process/host routing. Model chains are deliberately omitted so this
template cannot impose a personal provider, model or reasoning preference.

## Requirements and prerequisites

The minimum runtime verified for this configuration shape is OmO/Senpi 5.1.77.
That version is the disposable project-loader validation target for this
template. The native host route was previously exercised with OmO/Senpi 5.1.69;
that historical run proves the route only for its recorded configuration and
package revisions. Do not infer that every backend, task surface, or version
has equivalent guarded coverage.

Before using the roles:

- Pin the [verified local distribution](../../../../docs/local-work-distribution.md)
  by its manifest digest. The `@beady-eye/beads-work` source package is
  marked `"private": true`; its package version alone is not a release pin.
- Register the work adapter once in trusted OmO package settings and preserve
  unrelated packages. Do not register a second work writer or use a
  checkout-relative path as the lasting installation. The adapter uses the
  user's policy grant; this route does not require a `nestedDispatch` option.
- The passive observer remains optional and has its own separate registration.
  It reads execution evidence and does not grant policy, write work records,
  or replace the work adapter.
- Configure the user's trusted policy at
  `~/.config/beady-eye/work-policy.json`. The user chooses its scope and
  effective permissions. A repository config or role cannot grant itself
  access. Missing, invalid, ambiguous, or unsupported policy does not grant
  permissions.
- Confirm the project is bound to its canonical checkout and an existing
  supported local Beads store. Policy evaluation and work operations must not
  initialize a missing tracker.
- Confirm the actual runtime backend is the native host Tasks route and the
  installed integration is loaded in each participating session. Configured
  hooks alone do not establish route coverage.

## Provisioning at consumer cutover

Only provision or replace the consumer's active configuration at an
authorized cutover:

1. Save the current `.omo/omo.json` as a private backup outside version
   control. Review it and deliberately carry forward only permitted local
   settings; this template intentionally excludes model, provider, credential,
   and machine-specific values.
2. Copy this template into the checkout as a regular `.omo/omo.json` file.
   The file must have private user-only permissions and must not be a symlink.
3. Keep the active `.omo/omo.json` private and ignored. If it was previously
   tracked, coordinate its removal from the index with the consumer owner;
   an ignore rule alone does not untrack a file.
4. Install the pinned tooling tree or artifact and register its
   work adapter once. Register the optional observer separately if it is
   enabled. Keep the prior work-adapter registration and pinned artifact
   available until the new version passes native-host consumer acceptance.
5. At a safe reload boundary, with owned child tasks finished, load the private
   project config and audit the effective route and roles. Keep the active
   tracker, settings, and running sessions under their existing owners.

## Upgrade and rollback

For an upgrade, first finish or recover work owned by active tasks. Preserve
the exact prior private config and tooling-tree or artifact pin. Install the
new immutable pin, update the single work-adapter registration, and update the
separate observer registration only if the optional observer is enabled. Then
reload at a safe boundary and run the relevant disposable and consumer checks.
Keep the project config private and unchanged unless the pinned artifact
documents a required config revision.

If validation fails, return to a safe reload boundary, restore the previous
work-adapter registration and exact tooling-tree or artifact pin, restore the
separate observer registration if it was enabled, and restore the previous
regular private `.omo/omo.json` from its backup. Never register old and new
work adapters together, rewrite Beads records from a snapshot, or reassign an
interrupted attempt without explicit recovery by its observed owner. Preserve
the failed check and its evidence.

## Validation boundary

The template is validated by loading it with the actual OmO/Senpi 5.1.77
project configuration loader from an invented disposable checkout and private
runtime profile. That check establishes the accepted project path, config
shape, role discovery and resolved host-engine policy only. It does not install
the tooling tree or artifact, call a model, or prove native child admission.
Verify child admission and fixture behavior separately after activating a
new pin in a disposable consumer project.
