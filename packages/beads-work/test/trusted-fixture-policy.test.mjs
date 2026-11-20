import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateWorkPolicy } from "../policy.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "trusted-fixture-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, "work-policy.json");
  const binary = join(root, "where.mjs");
  await writeFile(binary, `#!${process.execPath}
import { join } from "node:path";
console.log(JSON.stringify({
  schema_version: 1, path: process.env.BEADS_DIR,
  database_path: join(process.cwd(), ".beads", "embeddeddolt")
}));`, { mode: 0o700 });
  const setPolicy = policy => writeFile(policyPath, JSON.stringify(policy));
  const store = async project => {
    const workspace = join(project, ".beads");
    const noms = join(workspace, "embeddeddolt", "grove", ".dolt", "noms");
    await mkdir(noms, { recursive: true });
    await writeFile(join(workspace, "metadata.json"), JSON.stringify({
      database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "grove",
    }));
    await writeFile(join(noms, "manifest"), "invented manifest");
  };
  const evaluate = cwd => evaluateWorkPolicy({ cwd, policyPath, binary });
  return { root, setPolicy, store, evaluate };
}

async function descriptor(root) {
  const path = join(root, "operator-fixture.json");
  const bytes = Buffer.from('{"version":1}');
  await writeFile(path, bytes);
  return { descriptor: path, sha256: hash(bytes) };
}

test("trusted fixture grants stay exact and private to authorized policy decisions", async t => {
  const f = await fixture(t);
  const project = join(f.root, "orchard");
  const inherited = join(f.root, "grove");
  await Promise.all([f.store(project), f.store(inherited)]);
  const grant = { "pear-check": await descriptor(f.root) };
  await f.setPolicy({ version: 1, scope: "selected-directories", defaultLevel: "observation",
    directories: [{ root: f.root, level: "management" }],
    projects: [{ root: project, level: "management", trustedFixtures: grant }] });

  const approved = await f.evaluate(project);

  assert.deepEqual(Object.keys(approved.trustedFixtures), ["pear-check"]);
  assert.deepEqual(approved.trustedFixtures["pear-check"], grant["pear-check"]);
  assert.equal(JSON.stringify(approved).includes(grant["pear-check"].descriptor), false);
  assert.equal((await f.evaluate(inherited)).trustedFixtures, undefined);
});

test("directory fixture grants, project-local descriptors, and stale hashes are denied", async t => {
  const f = await fixture(t);
  const project = join(f.root, "orchard");
  await f.store(project);
  const validGrant = { "pear-check": await descriptor(f.root) };
  const invalidGrants = [
    { ...validGrant, "not an id": validGrant["pear-check"] },
    { "pear-check": { ...validGrant["pear-check"], sha256: "0".repeat(64) } },
    { "pear-check": { ...validGrant["pear-check"], descriptor: join(project, "local.json") } },
  ];
  for (const trustedFixtures of invalidGrants) {
    await f.setPolicy({ version: 1, scope: "explicit-projects", defaultLevel: "disabled",
      projects: [{ root: project, level: "management", trustedFixtures }] });
    const decision = await f.evaluate(project);
    assert.equal(decision.source, "policy");
    assert.equal(decision.level, "disabled");
    assert.equal(decision.trustedFixtures, undefined);
  }

  await f.setPolicy({ version: 1, scope: "explicit-projects", defaultLevel: "disabled",
    directories: [{ root: project, trustedFixtures: validGrant }] });
  const inherited = await f.evaluate(project);
  assert.equal(inherited.source, "policy");
  assert.equal(inherited.level, "disabled");
});
