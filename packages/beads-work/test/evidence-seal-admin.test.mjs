import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyEvidenceSeal } from "../evidence-seal.mjs";

const root = process.env.BDI_TEST_ADMIN_SEAL_ROOT;
const digest = text => createHash("sha256").update(text).digest("hex");

test("the ordinary Node writer verifies a real administrator seal and rejects wrong authoritative expectations",
  { skip: root ? false : "requires the optional dummy archive in docs/evidence-seal-test.md" }, async () => {
    assert.match(root, /^\/var\/lib\/beady-eye-seal-test\.[A-Za-z0-9]{8}$/);
    assert.notEqual(process.getuid(), 0);
    const projectRoot = join(root, "project");
    const manifestPath = join(root, "manifest.json");
    const expectedFiles = { "evidence/receipt.txt": digest("Invented sealed evidence only.\n") };
    const inPlace = await verifyEvidenceSeal({ projectRoot, manifestPath, expectedFiles });
    assert.equal(inPlace.version, 1);
    assert.equal(inPlace.fileCount, 1);
    assert.equal(Object.hasOwn(inPlace, "archiveRoot"), false);
    assert.equal(inPlace.manifestSha256, digest(await readFile(manifestPath)));

    const writableProject = await mkdtemp(join(tmpdir(), "beads-work-writable-"));
    const mutableArchive = await mkdtemp(join(tmpdir(), "beads-work-mutable-archive-"));
    try {
      const verified = await verifyEvidenceSeal({
        projectRoot: writableProject, archiveRoot: projectRoot, manifestPath, expectedFiles,
      });
      assert.equal(verified.version, 1);
      assert.equal(verified.fileCount, 1);
      assert.equal(verified.archiveRoot, projectRoot);
      assert.equal(verified.manifestSha256, digest(await readFile(manifestPath)));

      for (const wrong of [
        { "evidence/receipt.txt": digest("unexpected accepted bytes") },
        { ...expectedFiles, "evidence/another-receipt.txt": digest("not in this archive") },
      ]) {
        await assert.rejects(verifyEvidenceSeal({
          projectRoot: writableProject, archiveRoot: projectRoot, manifestPath, expectedFiles: wrong,
        }));
      }
      await assert.rejects(verifyEvidenceSeal({
        projectRoot: writableProject, archiveRoot: projectRoot, manifestPath,
        expectedFiles: { "evidence/missing.txt": digest("missing") },
      }));
      await assert.rejects(verifyEvidenceSeal({
        projectRoot: writableProject, archiveRoot: mutableArchive, manifestPath, expectedFiles,
      }));
      for (const overlappingRoot of [writableProject, root, join(projectRoot, "nested")]) {
        await assert.rejects(verifyEvidenceSeal({
          projectRoot: writableProject, archiveRoot: overlappingRoot, manifestPath, expectedFiles,
        }));
      }
    } finally {
      await rm(writableProject, { recursive: true, force: true });
      await rm(mutableArchive, { recursive: true, force: true });
    }
  });
