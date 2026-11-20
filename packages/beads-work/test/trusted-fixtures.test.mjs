import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveTrustedFixture } from "../trusted-fixtures.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "trusted-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const operatorRoot = path.join(root, "operator");
  const inputPath = path.join(projectRoot, "inputs", "fixture.mjs");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await mkdir(operatorRoot);
  await writeFile(inputPath, "invented fixture input\n");

  const executable = async (name, contents) => {
    const filePath = path.join(operatorRoot, name);
    const bytes = Buffer.from(contents);
    await writeFile(filePath, bytes, { mode: 0o700 });
    return { filePath, sha256: hash(bytes) };
  };
  const primary = await executable("primary.sh", "#!/bin/sh\nexit 0\n");
  const cleanup = await executable("cleanup.sh", "#!/bin/sh\nexit 0\n");
  const verifyCleanup = await executable("verify-cleanup.sh", "#!/bin/sh\nexit 0\n");
  const projectInput = { path: "inputs/fixture.mjs", sha256: hash(await readFile(inputPath)) };
  const descriptor = {
    version: 1,
    executable: primary.filePath,
    sha256: primary.sha256,
    args: ["run", projectInput.path],
    cleanup: { executable: cleanup.filePath, sha256: cleanup.sha256, args: ["clean"] },
    verifyCleanup: { executable: verifyCleanup.filePath, sha256: verifyCleanup.sha256, args: ["verify"] },
    env: { PATH: "/usr/bin:/bin", FIXTURE_MODE: "disposable" },
    projectInputs: [projectInput],
  };
  const descriptorPath = path.join(operatorRoot, "descriptor.json");
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  const trustedFixtures = { "pear-check": { descriptor: descriptorPath, sha256: hash(descriptorBytes) } };
  return { root, projectRoot, operatorRoot, descriptorPath, descriptor, descriptorBytes,
    primary, cleanup, verifyCleanup, projectInput, inputPath, trustedFixtures };
}

test("resolver returns a descriptor with verified executable and project input pins", async t => {
  const f = await fixture(t);
  const resolved = await resolveTrustedFixture({
    trustedFixtures: f.trustedFixtures, fixtureId: "pear-check", projectRoot: f.projectRoot,
  });

  assert.deepEqual(Object.keys(resolved).sort(), ["descriptor", "descriptorSha256", "projectInputs"]);
  assert.deepEqual(Object.keys(resolved.descriptor).sort(), [
    "args", "cleanup", "env", "executable", "projectInputs", "sha256", "verifyCleanup", "version",
  ]);
  assert.equal(resolved.descriptorSha256, hash(f.descriptorBytes));
  assert.equal(resolved.descriptor.sha256, f.primary.sha256);
  assert.equal(resolved.descriptor.cleanup.sha256, f.cleanup.sha256);
  assert.equal(resolved.descriptor.verifyCleanup.sha256, f.verifyCleanup.sha256);
  assert.deepEqual(resolved.projectInputs, [f.projectInput]);
  assert.deepEqual(resolved.descriptor.args, ["run", "inputs/fixture.mjs"]);
  assert.deepEqual(resolved.descriptor.env, { PATH: "/usr/bin:/bin", FIXTURE_MODE: "disposable" });
});

test("resolver rejects changed descriptor, executable, and project input bytes", async t => {
  for (const changed of ["descriptor", "primary", "cleanup", "verifyCleanup", "projectInput"]) {
    await t.test(changed, async t => {
      const f = await fixture(t);
      if (changed === "descriptor") {
        await writeFile(f.descriptorPath, Buffer.concat([f.descriptorBytes, Buffer.from(" ")]));
      } else if (changed === "projectInput") {
        await writeFile(f.inputPath, "changed fixture input\n");
      } else {
        await writeFile(f[changed].filePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      }
      await assert.rejects(resolveTrustedFixture({
        trustedFixtures: f.trustedFixtures, fixtureId: "pear-check", projectRoot: f.projectRoot,
      }), { code: "trusted-fixture" });
    });
  }
});

test("resolver accepts pinned fixture inputs above the legacy fingerprint batch limit", async t => {
  const f = await fixture(t);
  const firstBytes = Buffer.alloc(18 * 1024 * 1024, 0x31);
  const secondBytes = Buffer.alloc(6 * 1024 * 1024, 0x32);
  const firstPath = path.join(f.projectRoot, "inputs", "first.apk");
  const secondPath = path.join(f.projectRoot, "inputs", "second.apk");
  await writeFile(firstPath, firstBytes);
  await writeFile(secondPath, secondBytes);
  const projectInputs = [
    { path: "inputs/first.apk", sha256: hash(firstBytes) },
    { path: "inputs/second.apk", sha256: hash(secondBytes) },
  ];
  const descriptor = { ...f.descriptor, projectInputs };
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(f.descriptorPath, bytes);

  const resolved = await resolveTrustedFixture({
    trustedFixtures: { "pear-check": { descriptor: f.descriptorPath, sha256: hash(bytes) } },
    fixtureId: "pear-check", projectRoot: f.projectRoot,
  });

  assert.deepEqual(resolved.projectInputs, projectInputs);
});

test("resolver rejects unapproved IDs and descriptors inside the project", async t => {
  const f = await fixture(t);
  await assert.rejects(resolveTrustedFixture({
    trustedFixtures: f.trustedFixtures, fixtureId: "other", projectRoot: f.projectRoot,
  }), { code: "trusted-fixture" });
  const localDescriptor = path.join(f.projectRoot, "local.json");
  const bytes = Buffer.from(JSON.stringify(f.descriptor));
  await writeFile(localDescriptor, bytes);
  await assert.rejects(resolveTrustedFixture({
    trustedFixtures: { "pear-check": { descriptor: localDescriptor, sha256: hash(bytes) } },
    fixtureId: "pear-check", projectRoot: f.projectRoot,
  }), { code: "trusted-fixture" });
});

test("resolver rejects changed input paths and symlink aliases", async t => {
  const f = await fixture(t);
  await symlink(f.inputPath, path.join(f.projectRoot, "inputs", "alias.mjs"));
  const descriptor = { ...f.descriptor, projectInputs: [
    { ...f.projectInput, path: "inputs/alias.mjs" },
  ] };
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(f.descriptorPath, bytes);
  await assert.rejects(resolveTrustedFixture({
    trustedFixtures: { "pear-check": { descriptor: f.descriptorPath, sha256: hash(bytes) } },
    fixtureId: "pear-check", projectRoot: f.projectRoot,
  }), { code: "trusted-fixture" });
});

test("descriptor v1 rejects duplicate keys, missing verifier, unknown fields and /init wrappers", async t => {
  const f = await fixture(t);
  for (const bytes of [
    Buffer.from('{"version":1,"version":1}'),
    Buffer.from(JSON.stringify({ ...f.descriptor, verifyCleanup: undefined })),
    Buffer.from(JSON.stringify({ ...f.descriptor, extra: true })),
    Buffer.from(JSON.stringify({ ...f.descriptor, executable: "/init" })),
  ]) {
    await writeFile(f.descriptorPath, bytes);
    await assert.rejects(resolveTrustedFixture({
      trustedFixtures: { "pear-check": { descriptor: f.descriptorPath, sha256: hash(bytes) } },
      fixtureId: "pear-check", projectRoot: f.projectRoot,
    }), { code: "trusted-fixture" });
  }
});

test("descriptor accepts a canonical external archive root and rejects overlapping roots", async t => {
  const f = await fixture(t);
  const archiveRoot = path.join(f.operatorRoot, "archive");
  await mkdir(archiveRoot);
  const manifest = path.join(f.operatorRoot, "manifest.json");
  await writeFile(manifest, "{}");
  const evidenceSeal = { manifest, archiveRoot };
  const descriptor = { ...f.descriptor, evidenceSeal };
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(f.descriptorPath, bytes);
  const grant = { "pear-check": { descriptor: f.descriptorPath, sha256: hash(bytes) } };
  const resolved = await resolveTrustedFixture({
    trustedFixtures: grant, fixtureId: "pear-check", projectRoot: f.projectRoot,
  });
  assert.deepEqual(resolved.descriptor.evidenceSeal, evidenceSeal);

  for (const badRoot of [f.projectRoot, path.dirname(f.projectRoot), path.join(f.projectRoot, "nested")]) {
    const changed = Buffer.from(JSON.stringify({
      ...f.descriptor, evidenceSeal: { manifest, archiveRoot: badRoot },
    }));
    await writeFile(f.descriptorPath, changed);
    await assert.rejects(resolveTrustedFixture({
      trustedFixtures: { "pear-check": { descriptor: f.descriptorPath, sha256: hash(changed) } },
      fixtureId: "pear-check", projectRoot: f.projectRoot,
    }), { code: "trusted-fixture" });
  }
  const alias = path.join(f.operatorRoot, "archive-alias");
  await symlink(archiveRoot, alias);
  for (const badRoot of [alias, path.join(f.operatorRoot, "missing-archive")]) {
    const changed = Buffer.from(JSON.stringify({
      ...f.descriptor, evidenceSeal: { manifest, archiveRoot: badRoot },
    }));
    await writeFile(f.descriptorPath, changed);
    await assert.rejects(resolveTrustedFixture({
      trustedFixtures: { "pear-check": { descriptor: f.descriptorPath, sha256: hash(changed) } },
      fixtureId: "pear-check", projectRoot: f.projectRoot,
    }), { code: "trusted-fixture" });
  }
});
