import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyEvidenceSeal } from "../evidence-seal.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpathTmp(), "evidence-seal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const evidenceDir = path.join(projectRoot, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "receipt.txt");
  const bytes = Buffer.from("Invented evidence fixture.\n");
  await writeFile(evidencePath, bytes);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = {
    version: 1,
    project: projectRoot,
    files: { "evidence/receipt.txt": hash(bytes) }
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, projectRoot, evidencePath, manifestPath, manifest, bytes };
}

async function realpathTmp() {
  return (await import("node:fs/promises")).realpath(tmpdir());
}

test("rejects a mutable synthetic fixture without changing its bytes", async t => {
  const fixtureFiles = await fixture(t);
  const before = await Promise.all([
    readFile(fixtureFiles.evidencePath),
    readFile(fixtureFiles.manifestPath)
  ]);
  await assert.rejects(
    verifyEvidenceSeal({
      projectRoot: fixtureFiles.projectRoot,
      manifestPath: fixtureFiles.manifestPath,
      expectedFiles: fixtureFiles.manifest.files
    }),
    { code: "evidence-seal" }
  );
  assert.deepEqual(await readFile(fixtureFiles.evidencePath), before[0]);
  assert.deepEqual(await readFile(fixtureFiles.manifestPath), before[1]);
});

test("rejects incomplete, alias, changed, and noncanonical expected paths", async t => {
  const fixtureFiles = await fixture(t);
  const cases = [
    {},
    { "evidence/receipt.txt": "0".repeat(64), "evidence/./receipt.txt": hash(fixtureFiles.bytes) },
    { "evidence/receipt.txt": "0".repeat(64) },
    { "evidence//receipt.txt": hash(fixtureFiles.bytes) },
    { "../outside.txt": hash(fixtureFiles.bytes) }
  ];
  for (const expectedFiles of cases) {
    await assert.rejects(
      verifyEvidenceSeal({ ...fixtureFiles, expectedFiles }),
      { code: "evidence-seal" }
    );
  }
});

test("rejects a manifest with extra or mismatched evidence entries", async t => {
  const fixtureFiles = await fixture(t);
  fixtureFiles.manifest.files["extra.txt"] = hash(Buffer.from("extra"));
  await writeFile(fixtureFiles.manifestPath, JSON.stringify(fixtureFiles.manifest));
  await assert.rejects(
    verifyEvidenceSeal({
      projectRoot: fixtureFiles.projectRoot,
      manifestPath: fixtureFiles.manifestPath,
      expectedFiles: { "evidence/receipt.txt": hash(fixtureFiles.bytes) }
    }),
    { code: "evidence-seal" }
  );
});

test("external archive mode binds manifest project and rejects cross-root paths", async t => {
  const fixtureFiles = await fixture(t);
  const separateProject = path.join(fixtureFiles.root, "writable");
  await mkdir(separateProject);
  const manifest = { ...fixtureFiles.manifest, project: fixtureFiles.projectRoot };
  await writeFile(fixtureFiles.manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyEvidenceSeal({
    projectRoot: separateProject, archiveRoot: fixtureFiles.projectRoot,
    manifestPath: fixtureFiles.manifestPath, expectedFiles: manifest.files,
  }), { code: "evidence-seal" });
  for (const archiveRoot of [
    separateProject,
    path.parse(separateProject).root,
    fixtureFiles.root,
    path.join(separateProject, "nested"),
  ]) {
    await assert.rejects(verifyEvidenceSeal({
      projectRoot: separateProject, archiveRoot, manifestPath: fixtureFiles.manifestPath,
      expectedFiles: manifest.files,
    }), { code: "evidence-seal" });
  }
});
