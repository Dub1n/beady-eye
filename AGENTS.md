# Working on this fork

Read CONTRIBUTING.md, CLAUDE.md and docs/design.md before changing code. This
file supplements their layering, terminology, test and contribution rules.

- Record requested behaviour as grouped checkboxes in INTENDED-CHANGES.md before
  implementation; tick only after implementation and relevant validation.
- When a change is complete, update the appropriate proposal in PROPOSED-PRS.md,
  or add a proposal if it has an independent upstream scope. Include extraction
  dependencies, compatibility, tests and remaining merge-readiness work. Read
  its shared contribution gate before preparing any upstream contribution.
- Keep docs/passive-activity.md current for settings and controls. Clearly
  distinguish fork defaults from optional upstream proposals.
- Preserve the full dependency snapshot for details, JSON and dependency views;
  the default ownership tree is a presentation projection. Identity is always
  (project, full bead ID). Filtering must not mutate tracker data.
- Native task activity is passive evidence, never an instruction to agents or
  acceptance proof. Keep missing, stale and conflicting evidence honest.
- Use invented data in committed tests and examples. Never commit local tracker
  records, logs, paths, model aliases or screenshots from the user's deployment.
- Use the existing draining PTY driver for terminal tests, window_over for popup
  absence, and bounded traversal helpers. Keep no-process tests in
  tests/never_start_bdi. Never change production defaults under cfg(test).
- Validate changed behaviours, Cargo formatting, tests and clippy. Run the Nix
  contribution checks when available; report unavailable checks explicitly.
  Empty GitHub check results are not a green CI verdict.
- Changes reach this fork's main through a squash-merged PR. Do not submit or
  message upstream without explicit authorization. Keep upstream proposals
  independently reviewable, with upstream defaults preserved unless agreed.
- Build/install the viewer through sh herdr/build.sh. Do not restart or control
  the user's Herdr panes. Reopening the viewer loads the newly installed binary.
