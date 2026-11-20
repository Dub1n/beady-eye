import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertWorkBinding, evaluateWorkPolicy, requireWorkCapability } from "../policy.mjs";

const exec = promisify(execFile);
const version1 = { version: 1, scope: "all-local", defaultLevel: "management" };
const missing = { code: "ENOENT" };

async function sandbox(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "work-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, "work-policy.json");
  const setPolicy = async (policy) => {
    const pending = join(root, "next-policy.json");
    await writeFile(pending, typeof policy === "string" ? policy : JSON.stringify(policy));
    await rename(pending, policyPath);
  };
  await setPolicy(version1);
  return { root, policyPath, setPolicy };
}

async function fakeStore(cwd) {
  const workspace = join(cwd, ".beads");
  const noms = join(workspace, "embeddeddolt", "grove", ".dolt", "noms");
  await mkdir(noms, { recursive: true });
  await writeFile(join(workspace, "metadata.json"), JSON.stringify({
    database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "grove",
  }));
  await writeFile(join(noms, "manifest"), "invented manifest");
  return workspace;
}

async function wireFixture(t, location = {}) {
  const { root, policyPath, setPolicy } = await sandbox(t);
  const binary = join(root, "where.mjs");
  const launched = join(root, "probe-ran");
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(${JSON.stringify(launched)}, "launched");
if (process.argv.slice(2).join(" ") !== "--sandbox --readonly where --json") process.exit(3);
console.log(JSON.stringify({
  schema_version: 1, path: process.env.BEADS_DIR,
  database_path: join(process.cwd(), ".beads", "embeddeddolt"), ...${JSON.stringify(location)}
}));`, { mode: 0o700 });
  const evaluate = (cwd, requestLevel) => evaluateWorkPolicy({ cwd, policyPath, binary, requestLevel });
  return { root, policyPath, setPolicy, launched, evaluate };
}

test("no project markers means no bd process", async t => {
  const { root, launched, evaluate } = await wireFixture(t);
  const decision = await evaluate(root);
  assert.equal(decision.project, null);
  assert.equal(decision.level, "disabled");
  await assert.rejects(access(launched), missing);
});

test("an explicit disabled grant never starts bd even with an eligible layout", async t => {
  const { root, launched, setPolicy, evaluate } = await wireFixture(t);
  await fakeStore(root);
  await setPolicy({ ...version1, projects: [{ root, level: "disabled", allowWslEvidenceChecks: true }] });
  const decision = await evaluate(root, "delegation");
  assert.equal(decision.level, "disabled");
  assert.equal(decision.source, "project");
  assert.equal(decision.allowWslEvidenceChecks, false);
  await assert.rejects(access(launched), missing);
});

test("unsupported, malformed, aliased and oversized policy files deny before spawn", async t => {
  const { root, policyPath, launched, setPolicy, evaluate } = await wireFixture(t);
  await fakeStore(root);
  await rm(policyPath);
  assert.equal((await evaluate(root)).source, "policy", "missing policy");
  const aliasTarget = join(root, "valid-policy.json");
  await writeFile(aliasTarget, JSON.stringify(version1));
  await symlink(aliasTarget, policyPath);
  assert.equal((await evaluate(root)).source, "policy", "policy symlink");
  const directories = Array.from({ length: 129 }, (_, index) => ({ root: join(root, String(index)) }));
  for (const entry of directories) await mkdir(entry.root);
  for (const [input, label] of [
    [{ ...version1, version: 2 }, "version"],
    [{ ...version1, scope: "wildcard" }, "scope"],
    [{ ...version1, enabled: true }, "unknown key"],
    [{ ...version1, projects: [{ root }] }, "project without level"],
    [{ ...version1, allowWslEvidenceChecks: true }, "top-level evidence capability"],
    [{ ...version1, directories: [{ root, allowWslEvidenceChecks: true }] }, "directory evidence capability"],
    [{ ...version1, projects: [{ root, level: "management", allowWslEvidenceChecks: "true" }] },
      "nonboolean project evidence capability"],
    [{ ...version1, directories: [{ root: "relative" }] }, "relative root"],
    [{ ...version1, directories }, "entry budget"],
    ['{"version":1,"scope":"all-local","defaultLevel":"disabled","defaultL\\u0065vel":"management"}', "duplicate key"],
    [" ".repeat(65536) + JSON.stringify(version1), "byte budget"],
  ]) {
    await setPolicy(input);
    const decision = await evaluate(root);
    assert.equal(decision.source, "policy", label);
    assert.equal(decision.level, "disabled", label);
    assert.equal(decision.binding, undefined, label);
  }
  await assert.rejects(access(launched), missing);
});

test("directory precedence uses components, inherits defaults and honors exact projects", async t => {
  const { root, setPolicy, evaluate } = await wireFixture(t);
  const work = join(root, "work");
  const team = join(work, "team");
  const archive = join(team, "archive");
  const exact = join(archive, "orchard");
  const outside = join(root, "workbench");
  const inherited = join(work, "inherited");
  for (const dir of [archive, exact, outside, inherited, join(team, "grove")]) await fakeStore(dir);
  const policy = {
    ...version1, scope: "selected-directories", defaultLevel: "observation",
    directories: [{ root: work }, { root: team, level: "management" }, { root: archive, level: "disabled" }],
    projects: [{ root: exact, level: "delegation" }],
  };
  await setPolicy(policy);
  for (const [dir, level, source] of [
    [archive, "disabled", "directory"], [exact, "delegation", "project"], [outside, "disabled", "scope"],
    [inherited, "observation", "directory"], [join(team, "grove"), "management", "directory"],
  ]) {
    const decision = await evaluate(dir);
    assert.deepEqual([decision.project, decision.level, decision.source], [dir, level, source]);
  }
  await setPolicy({ ...policy, scope: "explicit-projects" });
  assert.equal((await evaluate(inherited)).level, "disabled");
  assert.equal((await evaluate(exact)).level, "delegation");
});

test("WSL evidence checks require a valid exact project opt-in", async t => {
  const { root, setPolicy, evaluate } = await wireFixture(t);
  const exact = join(root, "orchard");
  const inherited = join(root, "other");
  await fakeStore(exact);
  await fakeStore(inherited);
  const policy = { ...version1, scope: "all-local", directories: [{ root }],
    projects: [{ root: exact, level: "management", allowWslEvidenceChecks: true }] };
  await setPolicy(policy);
  const optedIn = await evaluate(exact);
  assert.equal(optedIn.level, "management");
  assert.equal(optedIn.source, "project");
  assert.equal(optedIn.allowWslEvidenceChecks, true);
  assert.equal((await evaluate(inherited)).allowWslEvidenceChecks, false);
  await setPolicy({ ...policy, projects: [] });
  assert.equal((await evaluate(exact)).allowWslEvidenceChecks, false);
  await setPolicy({ ...policy, directories: [], projects: [] });
  assert.equal((await evaluate(exact)).allowWslEvidenceChecks, false);
  await setPolicy({ ...policy, scope: "explicit-projects", projects: [{ root: exact, level: "management" }] });
  assert.equal((await evaluate(exact)).allowWslEvidenceChecks, false);
});

test("cwd and configured aliases use canonical ancestry and duplicate roots deny", async t => {
  const { root, setPolicy, evaluate } = await wireFixture(t);
  const allowed = join(root, "allowed");
  const project = join(root, "outside");
  await mkdir(allowed);
  await fakeStore(project);
  const alias = join(allowed, "alias");
  await symlink(project, alias);
  await setPolicy({ ...version1, scope: "selected-directories", directories: [{ root: allowed }] });
  const aliased = await evaluate(alias);
  assert.deepEqual([aliased.project, aliased.level], [project, "disabled"]);
  await setPolicy({ ...version1, projects: [{ root: alias, level: "observation" }] });
  const decision = await evaluate(project);
  assert.deepEqual([decision.project, decision.level, decision.source], [project, "observation", "project"]);
  await setPolicy({ ...version1, directories: [{ root: alias }, { root: project, level: "disabled" }] });
  assert.equal((await evaluate(alias)).source, "policy");
});

test("a revocation denies new admissions and leaves the captured store binding checkable", async t => {
  const { root, setPolicy, evaluate } = await wireFixture(t);
  await fakeStore(root);
  const admitted = await evaluate(root);
  requireWorkCapability(admitted, "prepare", { mode: "direct" });
  assert.throws(() => requireWorkCapability(admitted, "prepare"), { code: "capability" });
  assert.throws(() => requireWorkCapability(admitted, "receipt"), { code: "capability" });
  assert.throws(() => requireWorkCapability(admitted, "prepare", { mode: "other" }), { code: "operation" });
  assert.equal(JSON.parse(JSON.stringify(admitted)).binding, undefined);
  await setPolicy({ ...version1, defaultLevel: "delegation" });
  const limited = await evaluate(root, "observation");
  requireWorkCapability(limited, "packet");
  assert.equal(limited.source, "request");
  assert.throws(() => requireWorkCapability(limited, "create"), { code: "capability" });
  const delegated = await evaluate(root);
  for (const operation of ["prepare", "begin", "receipt"]) requireWorkCapability(delegated, operation);
  await setPolicy({ ...version1, defaultLevel: "disabled" });
  const revoked = await evaluate(root);
  assert.throws(() => requireWorkCapability(revoked, "begin"), { code: "capability" });
  await assertWorkBinding(admitted.binding);
});

test("a symlinked workspace is rejected without probing a neighboring store", async t => {
  const { root, launched, evaluate } = await wireFixture(t);
  const external = await fakeStore(join(root, "external"));
  const project = join(root, "checkout");
  await mkdir(project);
  await symlink(external, join(project, ".beads"));
  assert.equal((await evaluate(project)).source, "store");
  await assert.rejects(access(launched), missing);
});

test("an ambiguous bd location reply is rejected with real local paths", async t => {
  const { root, launched, evaluate } = await wireFixture(t, { redirected_from: "/invented/other/.beads" });
  await fakeStore(root);
  const decision = await evaluate(root);
  await access(launched);
  assert.equal(decision.source, "store");
  assert.equal(decision.level, "disabled");
  assert.equal(decision.binding, undefined);
});

test("a same-path whole database replacement invalidates an admitted binding", async t => {
  const { root, evaluate } = await wireFixture(t);
  const workspace = await fakeStore(root);
  const replacement = await fakeStore(join(root, "replacement"));
  const admitted = await evaluate(root);
  await assertWorkBinding(admitted.binding);
  await rename(join(workspace, "embeddeddolt"), join(root, "retired"));
  await rename(join(replacement, "embeddeddolt"), join(workspace, "embeddeddolt"));
  await assert.rejects(assertWorkBinding(admitted.binding), { code: "binding" });
  requireWorkCapability(await evaluate(root), "show");
});

test("installed bd sees only the independently initialized nested Git worktree store", { timeout: 25_000 }, async t => {
  const { root, policyPath } = await sandbox(t);
  const checkout = join(root, "orchard");
  const worktree = join(checkout, "grove");
  const independent = join(root, "independent");
  const home = join(root, "home");
  const searchPath = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: searchPath, GIT_MASTER: "1",
    BD_DISABLE_METRICS: "1", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (binary, args, cwd) => exec(binary, args, { cwd, env, timeout: 8000, killSignal: "SIGKILL" });
  for (const dir of [checkout, independent, home]) await mkdir(dir);
  await run("git", ["init", "-q"], checkout);
  await run("git", ["worktree", "add", "--orphan", "-b", "grove", worktree], checkout);
  for (const dir of [checkout, independent]) {
    await run("bd", ["--sandbox", "init", "--non-interactive", "--skip-agents", "--skip-hooks", "-p", "grove"], dir);
  }
  const envOverrides = {
    HOME: home, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, BEADS_DIR: join(checkout, ".beads"),
    BEADS_DB: join(checkout, ".beads", "embeddeddolt"), BEADS_DOLT_SERVER_HOST: "invalid.example",
    GIT_DIR: join(checkout, ".git"), GIT_WORK_TREE: checkout,
  };
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(envOverrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  Object.assign(process.env, envOverrides);
  const evaluate = (cwd) => evaluateWorkPolicy({ cwd, policyPath });
  const absent = await evaluate(worktree);
  assert.deepEqual([absent.project, absent.level, absent.source], [worktree, "disabled", "store"]);
  await rename(join(independent, ".beads"), join(worktree, ".beads"));
  const admitted = await evaluate(worktree);
  assert.deepEqual([admitted.project, admitted.level], [worktree, "management"]);
  const { stdout } = await exec("bd", ["--sandbox", "--readonly", "where", "--json"],
    { cwd: admitted.project, env: admitted.binding.env, timeout: 3000, killSignal: "SIGKILL" });
  assert.equal(JSON.parse(stdout).database_path, join(worktree, ".beads", "embeddeddolt"));
});
