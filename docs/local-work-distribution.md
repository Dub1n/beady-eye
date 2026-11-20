# Local distribution for the optional work integration

The local source bundle includes the versioned work package and CLI, OmO
adapters, QR-Clip template, and locked viewer build inputs. Its allowlist
excludes installed settings, Git state, tracker stores, captured evidence,
and tool credentials. The bundle contains source. Build the viewer on the
target machine.

With Node 22 and a fresh private canonical parent outside the source checkout:

```sh
node tools/local-work-dist.mjs assemble "$RELEASE_PARENT"
node tools/local-work-dist.mjs verify "$RELEASE_DIRECTORY" "$MANIFEST_SHA256"
```

Assembly reports the version, release directory and SHA-256 of the
manifest. Record that digest independently in the deployment record.
Verify with the trusted tool from your source checkout.
The same version may have several local builds with different digests.
Verify the exact pin before registration. Treat fingerprints as integrity
checks against a trusted pin. Keep the release directory unchanged.

For trusted fixtures, the bundle includes the resolver, not any operator
policy, approved descriptor, executable, or evidence from a project.
Select the verified release's CLI explicitly and check `limits {}` for
`trustedFixtureCheckVersion: 1`. Verify that `policy` lists only the
expected fixture IDs for the intended project. For OmO, check the same
version through the loaded tool after a safe reload. A policy ID or a
version probe alone is not a successful fixture run.

If a descriptor requires an administrator-applied immutable evidence seal,
also require `evidenceSealVersion: 1`. The bundle carries its Node verifier
and isolated Python inspector. Neither the writer nor these helpers may be
run with elevated privileges. Qualify both the archive layout and the actual
ordinary execution identities with the [dummy seal test](evidence-seal-test.md)
before using that mode on an operator-managed archive.
When staging the seal outside the writable checkout using `archiveRoot`,
require `externalEvidenceArchiveVersion: 1` from both the selected CLI and
the loaded OmO writer. An older build can report `evidenceSealVersion: 1`
without understanding external roots. Compare the distribution digest,
not just the package version.

To build bdi, copy the verified distribution to a private build directory
and use `sh herdr/build.sh` there. The script builds the checkout's locked
viewer and installs `bin/bdi` inside that build directory. Record the
executable digest with the source pin.

Enable projects explicitly with the user policy in
[the work integration contract](work-integration.md). For QR-Clip, follow
the [versioned template and rollback instructions](../adapters/omo-work/templates/qrclip-v1/README.md).
Preserve unrelated OmO packages. Register the work adapter once from the
release and configure the optional observer separately for the same project.
