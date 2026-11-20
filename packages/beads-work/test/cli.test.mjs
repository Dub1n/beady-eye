import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const entry = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const exec = promisify(execFile);

test("the installed CLI with a user grant diagnoses an empty project without creating a store", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "beads-work-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "orchard");
  const policy = path.join(root, "work-policy.json");
  await mkdir(project);
  await writeFile(policy, JSON.stringify({
    version: 1,
    scope: "all-local",
    defaultLevel: "delegation",
    directories: [],
    projects: [],
  }), { mode: 0o600 });

  const { stdout } = await exec(process.execPath, [entry, "policy"], {
    cwd: project, env: { ...process.env, BDI_WORK_POLICY: policy }, timeout: 5000,
  });
  assert.equal(JSON.parse(stdout).level, "disabled");
  assert.equal(JSON.parse(stdout).allowWslEvidenceChecks, undefined);
  assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(),
    ["level", "project", "reason", "source", "version"]);
  assert.deepEqual(await readdir(project), []);
});

test("CLI policy output exposes an exact project WSL evidence opt-in", async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "beads-work-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "orchard");
  const home = path.join(root, "home");
  const policy = path.join(root, "work-policy.json");
  await Promise.all([mkdir(project), mkdir(home)]);
  const descriptor = path.join(home, "operator-fixture.json");
  const descriptorBytes = Buffer.from('{"version":1}');
  await writeFile(descriptor, descriptorBytes);
  const noms = path.join(project, ".beads", "embeddeddolt", "grove", ".dolt", "noms");
  await mkdir(noms, { recursive: true });
  await writeFile(path.join(noms, "manifest"), "invented manifest");
  await writeFile(path.join(project, ".beads", "metadata.json"), JSON.stringify({
    database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "grove",
  }));
  await writeFile(policy, JSON.stringify({ version: 1, scope: "explicit-projects",
    defaultLevel: "disabled", projects: [{ root: project, level: "management", allowWslEvidenceChecks: true,
      trustedFixtures: { "pear-check": { descriptor,
        sha256: createHash("sha256").update(descriptorBytes).digest("hex") } } }] }),
  { mode: 0o600 });
  const { stdout } = await exec(process.execPath, [entry, "policy"], {
    cwd: project, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, BDI_WORK_POLICY: policy }, timeout: 5000,
  });
  const result = JSON.parse(stdout);
  assert.deepEqual([result.level, result.allowWslEvidenceChecks, result.trustedFixtures],
    ["management", true, ["pear-check"]]);
  assert.equal(stdout.includes(descriptor), false);
});

test("the CLI applies the user grant before prepare in a real disposable store", { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "beads-work-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "orchard");
  const cwd = path.join(project, "src");
  const home = path.join(root, "home");
  const policy = path.join(home, "work-policy.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(home);
  await writeFile(policy, JSON.stringify({ version: 1, scope: "explicit-projects",
    defaultLevel: "disabled", projects: [{ root: project, level: "management" }] }), { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home,
    BD_NO_HOOKS: "true", BD_DISABLE_METRICS: "1", GIT_MASTER: "1",
    BEADS_DOLT_SHARED_SERVER: "false", BD_DOLT_SHARED_SERVER: "false",
    BDI_WORK_POLICY: policy, QRCLIP_AGENT_SESSION: "invented-session",
  };
  await exec("bd", ["--sandbox", "init", "--non-interactive", "--skip-agents", "--skip-hooks", "-p", "fruit"],
    { cwd: project, env, timeout: 10_000, killSignal: "SIGKILL" });
  const run = async (operation, input) => {
    const { stdout } = await exec(process.execPath, [entry, operation, JSON.stringify(input)],
      { cwd, env, timeout: 5000, killSignal: "SIGKILL" });
    return JSON.parse(stdout);
  };
  const created = await run("create", { title: "Inspect pears", objective: "Review the crate", paths: ["src"] });
  await assert.rejects(run("prepare", { id: created.id }), (error) =>
    error instanceof Error && JSON.parse(error.stderr).code === "capability");
  const issue = await run("show", { id: created.id });
  assert.equal(issue.status, "open");
  assert.equal(issue.metadata.qrclipWork.attempt, undefined);
  const prepared = await run("prepare", { id: created.id, mode: "direct" });
  assert.equal(prepared.packet.attempt.coordinator, "invented-session");
});
