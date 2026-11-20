import test, { after } from "node:test";
// allow: SIZE_OK — The pinned tracker cases share fixtures as one assigned contract suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile, mkdir, symlink, chmod, readdir, lstat, link } from "node:fs/promises";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os, { release, version } from "node:os";
import { createWorkTracker, WorkError } from "../agent-work.mjs";
import { runWorkCommand } from "../agent-work-cli.mjs";

const exec = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = await mkdtemp(path.join(os.tmpdir(), "beads-work-suite-"));
const previousBeadsDir = process.env.BEADS_DIR;
process.env.BEADS_DIR = path.join(cwd, ".beads");
after(async () => {
  if (previousBeadsDir === undefined) delete process.env.BEADS_DIR;
  else process.env.BEADS_DIR = previousBeadsDir;
  await rm(cwd, { recursive: true, force: true });
});
await exec("bd", ["init", "--non-interactive", "--skip-agents", "--prefix", "bdi"], {
  cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 30000,
});
const onWsl = process.platform === "linux" && /microsoft|wsl/i.test(`${release()} ${version()}`);

async function isolatedWslStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beads-wsl-disposable-"));
  t.after(() => rm(directory, { recursive: true }));
  const binary = path.join(directory, "bd-fixture");
  await writeFile(binary, await readFile(path.join(packageRoot, "test", "agent-work-test-bd.mjs")), { mode: 0o700 });
  const state = path.join(directory, "state.json");
  await writeFile(binary + ".json", JSON.stringify({ mode: "disposable-store", state }));
  const original = path.join(directory, "original.txt");
  await writeFile(original, "fresh disposable original");
  const sha256 = createHash("sha256").update(await readFile(original)).digest("hex");
  const saved = path.join(".beads", "retired-artifacts", "disposable", sha256);
  await mkdir(path.dirname(path.join(directory, saved)), { recursive: true });
  await writeFile(path.join(directory, saved), await readFile(original), { mode: 0o444 });
  const attempt = "11111111-1111-4111-8111-111111111111";
  const base = { id: "disposable", status: "in_progress", assignee: `omo:${attempt}`,
    metadata: { qrclipWork: { version: 1, paths: [], attempt: { id: attempt, name: "disposable" } } } };
  return { directory, state, original, sha256, saved, attempt, base,
    tracker: createWorkTracker({ cwd: directory, actor: "disposable", binary }) };
}

test("fingerprint metadata ordering preserves dispatch and acceptance freshness", { timeout: 55000 }, async t => {
  for (const boundary of ["dispatch", "acceptance"]) {
    for (const mutation of ["unchanged", "modified", "added", "deleted"]) {
      await t.test(`${boundary}: ${mutation}`, async st => {
        const f = await isolatedWslStore(st);
        const binary = path.join(f.directory, "bd-fixture");
        // Go JSON maps use byte-sorted keys. Apply that serialization to the
        // existing disposable store at the source/receipt map boundary.
        const proxy = (await readFile(binary, "utf8"))
          .replace('if (operation === "show") {',
            'if (operation === "comments") { process.stdout.write("[]"); } else if (operation === "show") {')
          .replace("JSON.stringify(state)", `JSON.stringify(state, (key, value) =>
            ["sources", "prerequisites"].includes(key) && value && typeof value === "object"
              ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
              : value)`);
        await writeFile(binary, proxy);
        await mkdir(path.join(f.directory, "android"));
        await writeFile(path.join(f.directory, "README.md"), "readme source");
        await writeFile(path.join(f.directory, "android", "source.txt"), "android source");
        await writeFile(f.state, JSON.stringify({ disposable: {
          id: "disposable", status: "open", assignee: "",
          metadata: { qrclipWork: { version: 1, paths: ["README.md", "android"] } },
        } }));
        if (boundary === "dispatch" && mutation === "unchanged") {
          // Dependency traversal order differs from the persisted receipt map.
          for (const id of ["parent-z", "parent-A"]) {
            const state = JSON.parse(await readFile(f.state, "utf8"));
            state[id] = { id, status: "open", assignee: "",
              metadata: { qrclipWork: { version: 1, paths: [] } } };
            await writeFile(f.state, JSON.stringify(state));
            const parent = await f.tracker.prepare(id, { mode: "direct" });
            const checked = await f.tracker.check(id, parent.attempt, {
              command: process.execPath, args: ["-e", ""], budgetMs: 5000,
            });
            assert.equal(checked.passed, true);
            assert.equal((await f.tracker.accept(id, parent.attempt)).accepted, true);
          }
          const state = JSON.parse(await readFile(f.state, "utf8"));
          state.disposable.dependencies = ["parent-z", "parent-A"].map(id =>
            ({ id, dependency_type: "blocks" }));
          await writeFile(f.state, JSON.stringify(state));
        }
        const prepared = await f.tracker.prepare("disposable",
          { mode: boundary === "dispatch" ? "delegate" : "direct" });
        let proof;
        if (boundary === "acceptance") {
          proof = await f.tracker.check("disposable", prepared.attempt, {
            command: process.execPath, args: ["-e", ""], budgetMs: 5000,
          });
          assert.equal(proof.passed, true, "Actual executed check must publish passing proof");
        }
        const persisted = await f.tracker.issue("disposable");
        const sources = boundary === "dispatch"
          ? persisted.metadata.qrclipWork.attempt.sources
          : persisted.metadata.qrclipWork.checked.sources;
        assert.deepEqual(Object.keys(sources), ["README.md", "android/", "android/source.txt"],
          "Datastore must persist byte order across actual prepare/check publication");
        assert.notDeepEqual(Object.keys(sources),
          [...Object.keys(sources)].sort((a, b) => a.localeCompare(b)));
        assert.equal(persisted.assignee, `omo:${prepared.attempt}`);
        if (boundary === "dispatch" && mutation === "unchanged")
          assert.deepEqual(Object.keys(persisted.metadata.qrclipWork.attempt.prerequisites),
            ["parent-A", "parent-z"], "Persisted receipts reverse actual dependency traversal");
        switch (mutation) {
          case "unchanged": break;
          case "modified": await writeFile(path.join(f.directory, "README.md"), "changed bytes"); break;
          case "added": await writeFile(path.join(f.directory, "android", "new.txt"), "new source"); break;
          case "deleted": await rm(path.join(f.directory, "android", "source.txt")); break;
          default: assert.fail("Unknown source mutation");
        }
        const operation = boundary === "dispatch"
          ? f.tracker.beginDispatch("disposable", prepared.attempt)
          : f.tracker.accept("disposable", prepared.attempt);
        if (mutation === "unchanged") {
          const result = await operation;
          if (boundary === "dispatch") assert.equal(result.status, "in_progress");
          else assert.equal(result.accepted, true);
        } else {
          await assert.rejects(operation, { code: boundary === "dispatch" ? "stale-input" : "unverified" });
          const rejected = await f.tracker.issue("disposable");
          assert.equal(rejected.status, boundary === "dispatch" ? "hooked" : "in_progress");
          assert.equal(rejected.assignee, `omo:${prepared.attempt}`);
          assert.equal(rejected.metadata.qrclipWork.accepted, undefined);
        }
      });
    }
  }
});

test("WSL protected checks reject Windows primary and cleanup before any side effect",
  { skip: !onWsl, timeout: 20000 }, async t => {
    const f = await isolatedWslStore(t);
    const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const cleanupMarker = path.join(f.directory, "cleanup-invoked.txt");
    const windowsPath = async file => (await exec("wslpath", ["-w", file], { timeout: 2000 })).stdout.trim();
    const writeArgs = async file => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `[IO.File]::WriteAllText('${(await windowsPath(file)).replaceAll("'", "''")}','escaped')`];
    const primaryArgs = await writeArgs(f.original);
    const cleanupArgs = await writeArgs(cleanupMarker);
    // Remove interop environment hints: the kernel identity must still reject.
    const hints = Object.fromEntries(["WSL_INTEROP", "WSL_DISTRO_NAME"].map(key => [key, process.env[key]]));
    try {
      delete process.env.WSL_INTEROP;
      delete process.env.WSL_DISTRO_NAME;
      for (const protection of ["archive", "prerequisite", "first-case"]) {
        const issue = structuredClone(f.base);
        const state = { disposable: issue };
        if (protection !== "prerequisite") {
          issue.metadata.qrclipWork.retiredArtifacts = ["original.txt"];
          issue.metadata.qrclipWork.artifactArchives = [{
            receipt: { path: "original.txt", sha256: f.sha256 },
            artifacts: { "original.txt": { path: f.saved, sha256: f.sha256 } },
          }];
        } else {
          issue.dependencies = [{ id: "parent", dependency_type: "blocks" }];
          state.parent = { id: "parent", status: "closed", metadata: { qrclipWork: {
            version: 1, paths: [], accepted: { paths: [], sources: {},
              receipt: { path: "original.txt", sha256: f.sha256 } },
          } } };
        }
        if (protection === "first-case")
          issue.metadata.qrclipWork.fixture = { stage: "first-case", visual: false };
        await writeFile(f.state, JSON.stringify(state));
        const before = await readFile(f.state);
        await assert.rejects(f.tracker.check("disposable", f.attempt, {
          command: powershell, args: primaryArgs, budgetMs: 5000,
          cleanup: { command: powershell, args: cleanupArgs },
          ...(protection === "first-case" ? { firstCase: {
            report: "fresh/report.json", manifest: "fresh/manifest.json", visualEvidence: [],
          } } : {}),
        }), error => error.code === "artifact-protection-unavailable" && /WSL/.test(error.message));
        assert.deepEqual(await readFile(f.state), before, "No reservation or metadata write");
        assert.equal(await readFile(f.original, "utf8"), "fresh disposable original");
        assert.equal(await readFile(path.join(f.directory, f.saved), "utf8"), "fresh disposable original");
        await assert.rejects(readFile(cleanupMarker), { code: "ENOENT" });
        await assert.rejects(readdir(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
      }
    } finally {
      for (const [key, value] of Object.entries(hints))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // A separate host writer is intentionally outside the check owner's boundary.
    await exec(process.execPath, ["-e",
      `require("node:fs").writeFileSync(${JSON.stringify(f.original)}, "unrelated host writer")`],
    { timeout: 2000 });
    assert.equal(await readFile(f.original, "utf8"), "unrelated host writer");
  });


test("WSL ordinary unprotected checks retain primary and cleanup execution",
  { skip: !onWsl, timeout: 15000 }, async t => {
    const f = await isolatedWslStore(t);
    await writeFile(f.state, JSON.stringify({ disposable: f.base }));
    const marker = path.join(f.directory, "ordinary.txt");
    const result = await f.tracker.check("disposable", f.attempt, {
      command: process.execPath, args: ["-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "primary")`],
      budgetMs: 10000,
      cleanup: { command: process.execPath, args: ["-e",
        `require("node:fs").appendFileSync(${JSON.stringify(marker)}, " cleanup")`] },
    });
    assert.equal(result.passed, true);
    assert.equal(await readFile(marker, "utf8"), "primary cleanup");
  });

async function removeFixtureArchives(ids) {
  const store = path.join(cwd, ".beads", "retired-artifacts");
  let directories;
  try { directories = await readdir(store, { withFileTypes: true }); }
  catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
    return;
  }
  for (const entry of directories) {
    // mkdtemp appends exactly six characters after this fixture's complete ID.
    if (entry.name.at(-7) !== "-" || !/^[a-zA-Z0-9]{6}$/.test(entry.name.slice(-6)) ||
        !ids.includes(entry.name.slice(0, -7))) continue;
    const directory = path.join(store, entry.name);
    assert.equal(entry.isDirectory() && !entry.isSymbolicLink(), true, "Refuse unrelated archive backing");
    for (const name of await readdir(directory)) {
      assert.match(name, /^[a-f0-9]{64}$/);
      assert.equal((await lstat(path.join(directory, name))).isFile(), true);
    }
    // Only directories created for these newly disposable fixture IDs change mode.
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true });
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(cwd, ".beads-work-test-"));
  const input = path.join(directory, "input.txt");
  await writeFile(input, "initial source");
  const tracker = createWorkTracker({ cwd, actor: "contract-test" });
  const ids = [];
  t.after(async () => {
    // These are only the synthetic issues created by this fixture.
    const failures = [];
    for (const id of ids) {
      try {
        await exec("bd", ["--sandbox", "close", id, "--force", "--reason", "Disposable contract fixture cleanup"],
          { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
      } catch (error) { failures.push(error); }
    }
    try { await removeFixtureArchives(ids); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Disposable fixture cleanup failed");
  });
  return {
    tracker, input,
    track(id) { ids.push(id); },
    async create(blockedBy = [], extra = {}) {
      const value = await tracker.create({
        title: "Disposable adapter contract fixture",
        objective: "Exercise real Beads transitions; no device or model operations.",
        paths: [path.relative(cwd, input)], blockedBy, ...extra,
      });
      ids.push(value.id);
      return value.id;
    },
  };
}

async function firstCaseEvidence(f, { visual = false, report = {}, prefix = "" } = {}) {
  const directory = path.join(path.dirname(f.input), prefix ? prefix.replace(/-$/, "") : "evidence");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "first-case-report.json");
  const manifestPath = path.join(directory, "observation-manifest.json");
  const sourcePath = path.relative(cwd, f.input);
  const pngPath = path.join(directory, "visual.png");
  await writeFile(f.input, "contract simulation source");
  const sourceHash = createHash("sha256").update(await readFile(f.input)).digest("hex");
  await writeFile(manifestPath, JSON.stringify({
    status: "complete", primary: { ok: true },
    failures: { primary: [], diagnostic: [], termination: [], cleanup: [], publication: [] },
  }));
  const visualEvidence = [];
  if (visual) {
    // A fixed, valid 1x1 PNG; this exercises artifact validation, not Android rendering.
    await writeFile(pngPath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=",
      "base64",
    ));
    visualEvidence.push(path.relative(cwd, pngPath));
  }
  await writeFile(reportPath, JSON.stringify({
    passed: true,
    cleanup: [{ passed: true, detail: "contract fixture cleanup" }],
    publicationErrors: [],
    source: { files: { [sourcePath]: sourceHash } },
    observation: { ok: true, manifestPath: path.relative(cwd, manifestPath) },
    ...report,
  }));
  return {
    report: path.relative(cwd, reportPath),
    visualEvidence,
    reportPath,
    manifestPath,
    pngPath,
  };
}

async function acceptFirstCase(f, id, attempt, evidence, { expectedPassed = true } = {}) {
  const command = `
    const fs = require("node:fs");
    const binding = {
      nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
      id: process.env.QRCLIP_AGENT_WORK_ID,
      attempt: process.env.QRCLIP_WORK_CHECK_ATTEMPT,
    };
    const reportPath = ${JSON.stringify(evidence.reportPath)};
    const manifestPath = ${JSON.stringify(evidence.manifestPath)};
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    report.workCheck = binding;
    manifest.workCheck = binding;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  `;
  const proof = await f.tracker.check(id, attempt, {
    command: process.execPath,
    args: ["-e", command],
    firstCase: { report: evidence.report, manifest: path.relative(cwd, evidence.manifestPath),
      visualEvidence: evidence.visualEvidence },
  });
  assert.equal(proof.passed, expectedPassed, `First check receipt: ${proof.receipt.path}\n${
    proof.passed === expectedPassed ? "" : await readFile(path.join(cwd, proof.receipt.path), "utf8")}`);
  return proof;
}

const firstCaseReview = "Observed scenario and artifacts match actual case; cleanup complete.";

function observationFirstCaseCode(evidence, observationDirectory, { reportedManifest, copyManifest = false, alias } = {}) {
  const observer = new URL("../harness-observation.mjs", import.meta.url).href;
  return `
    const {createRunContext} = await import(${JSON.stringify(observer)});
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const {createHash} = await import("node:crypto");
    const run = await createRunContext({
      output:${JSON.stringify(observationDirectory)},scenario:"stage6-ui",
      budgetMs:15000,primaryMs:10000,cleanupMs:4000,publicationMs:1000,
    });
    run.phase("preflight","complete");
    await run.runCommand(process.execPath,["-e",""],{label:"fixture-host-command",timeout:2000});
    run.setPrimary({passed:true});
    const terminal = await run.finalize({cleanupErrors:[],publicationErrors:[],cleanupVerified:true});
    if (${JSON.stringify(copyManifest)})
      await fs.copyFile(terminal.manifestPath,${JSON.stringify(reportedManifest)});
    const reportPath = ${JSON.stringify(evidence.reportPath)};
    const report = JSON.parse(await fs.readFile(reportPath,"utf8"));
    report.scenario = "stage6-ui";
    report.primary = {passed:true};
    report.checks = [{name:"fixture-host-command",passed:true}];
    report.captures = [];
    report.workCheck = run.workCheck;
    report.source.files["harness-observation.mjs"] =
      createHash("sha256").update(await fs.readFile(new URL(${JSON.stringify(observer)}))).digest("hex");
    let manifestPath = terminal.manifestPath;
    if (${JSON.stringify(alias ?? null)}) {
      const alias = path.join(${JSON.stringify(observationDirectory)},"manifest-alias.json");
      if (${JSON.stringify(alias)} === "symlink") await fs.symlink(manifestPath,alias);
      else await fs.link(manifestPath,alias);
      manifestPath = alias;
    }
    report.observation = {ok:terminal.ok,manifestPath:${JSON.stringify(reportedManifest)} ?? manifestPath,
      publicationComplete:terminal.publicationComplete};
    await fs.writeFile(reportPath,JSON.stringify(report));
  `;
}

async function refreshedProtectedCase(f) {
  const id = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const attempt = await f.tracker.prepare(id, { mode: "direct" });
  const old = await firstCaseEvidence(f, { visual: true });
  await acceptFirstCase(f, id, attempt.attempt, old);
  await f.tracker.accept(id, attempt.attempt, { review: firstCaseReview });
  const accepted = await f.tracker.issue(id);
  await writeFile(f.input, "stale source before protected command execution");
  await f.tracker.recover(id, { operation: "refresh-first-case", assignee: accepted.assignee,
    status: "closed", confirmedStopped: true, reason: "Protect original evidence and retained copies." });
  const refreshed = await f.tracker.issue(id);
  const originals = [...Object.keys(accepted.metadata.qrclipWork.accepted.firstCase.artifacts),
    accepted.metadata.qrclipWork.accepted.receipt.path];
  const copies = Object.values(refreshed.metadata.qrclipWork.artifactArchives[0].artifacts).map(saved => saved.path);
  const files = [...originals, ...copies];
  const bytes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, (await readFile(path.join(cwd, file))).toString("base64")])));
  const modes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, (await lstat(path.join(cwd, file))).mode & 0o777])));
  const next = await f.tracker.prepare(id, { mode: "direct" });
  const fresh = await firstCaseEvidence(f, { visual: true, prefix: "fresh-" });
  return { id, attempt: next.attempt, old, fresh, files, bytes, modes, accepted };
}

function immutableProbeCode(scenario, role) {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const assert = require("node:assert/strict");
    const files = ${JSON.stringify(scenario.files)};
    const bytes = ${JSON.stringify(scenario.bytes)};
    const output = ${JSON.stringify(path.dirname(scenario.fresh.reportPath))};
    let denied = 0;
    const deny = action => {
      assert.throws(action, error => ["EROFS","EACCES","EPERM","EBUSY","EXDEV"].includes(error.code));
      denied++;
    };
    for (const [index, file] of files.entries()) {
      assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes[file], "base64"));
      const replacement = path.join(output, ${JSON.stringify(role)} + "-replacement-" + index);
      fs.writeFileSync(replacement, "fresh replacement");
      deny(() => fs.writeFileSync(file, "forbidden overwrite"));
      deny(() => fs.truncateSync(file, 0));
      deny(() => fs.unlinkSync(file));
      deny(() => fs.renameSync(file, replacement + "-moved"));
      deny(() => fs.renameSync(replacement, file));
      deny(() => fs.copyFileSync(replacement, file));
      deny(() => fs.renameSync(path.dirname(file), replacement + "-parent"));
      deny(() => fs.linkSync(file, replacement + "-alias"));
      deny(() => fs.chmodSync(file, 0o600));
      assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes[file], "base64"));
    }
    if (${JSON.stringify(role)} === "primary") {
      const binding = {nonce:process.env.QRCLIP_WORK_CHECK_NONCE,
        id:process.env.QRCLIP_AGENT_WORK_ID,attempt:process.env.QRCLIP_WORK_CHECK_ATTEMPT};
      const reportPath = ${JSON.stringify(scenario.fresh.reportPath)};
      const manifestPath = ${JSON.stringify(scenario.fresh.manifestPath)};
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      report.workCheck = binding;
      manifest.workCheck = binding;
      fs.writeFileSync(reportPath, JSON.stringify(report));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    fs.writeFileSync(path.join(output, ${JSON.stringify(role)} + "-protection.json"),
      JSON.stringify({denied, fresh:true}));
  `;
}

test("dispatcher limits expose guarded recovery capability", async () => {
  const tracker = createWorkTracker({ cwd, actor: "recovery-capability-contract" });
  assert.equal(tracker.limits().recoveryContractVersion, 3);
  assert.equal((await runWorkCommand(tracker, "limits", {})).recoveryContractVersion, 3);
});

test("functional checks admit a bounded nested run while measurement checks remain capped", async t => {
  const f = await fixture(t);
  assert.equal(f.tracker.limits().deadlineContractVersion, 1);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  await assert.rejects(f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", ""], budgetMs: 300000,
  }), { code: "input" });
  assert.equal((await f.tracker.issue(id)).status, "in_progress");

  const resultPath = path.join(path.dirname(f.input), "nested.json");
  const observer = new URL("../harness-observation.mjs", import.meta.url).href;
  const code = `
    import {createRunContext} from ${JSON.stringify(observer)};
    import {writeFile} from "node:fs/promises";
    const run = await createRunContext({output:${JSON.stringify(path.dirname(f.input))},
      budgetMs:300000, cleanupMs:85000, publicationMs:5000});
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({
      inherited:Number(process.env.QRCLIP_HARNESS_DEADLINE_EPOCH_MS),
      whole:run.deadlines.wholeEpochMs, primary:run.deadlines.primaryEpochMs,
      cleanup:run.deadlines.cleanupEpochMs,
    }));
    run.setPrimary({passed:true});
    await run.finalize();
  `;
  const proof = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["--input-type=module", "-e", code],
    kind: "functional", budgetMs: 300000,
  });
  assert.equal(proof.passed, true);
  const nested = JSON.parse(await readFile(resultPath, "utf8"));
  const receipt = JSON.parse(await readFile(path.join(cwd, proof.receipt.path), "utf8"));
  assert.ok(nested.whole <= nested.inherited);
  assert.ok(nested.inherited <= Date.parse(receipt.createdAt) + 210000);
  assert.ok(nested.primary < nested.cleanup && nested.cleanup <= nested.whole);
});


test("cleanup that makes a tracked source invalid records a failed check and releases ownership", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const proof = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", ""],
    cleanup: { command: process.execPath, args: ["-e",
      `const fs=require("node:fs");fs.unlinkSync(${JSON.stringify(f.input)});fs.symlinkSync("target",${JSON.stringify(f.input)});`] },
  });
  const receipt = JSON.parse(await readFile(path.join(cwd, proof.receipt.path), "utf8"));
  assert.equal(proof.passed, false);
  assert.equal(receipt.status, "failed");
  assert.equal((await f.tracker.issue(id)).status, "in_progress");
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
});

test("preflight failure invalidates an earlier passing proof before releasing the attempt", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const first = await f.tracker.check(id, prepared.attempt, { command: process.execPath, args: ["-e", ""] });
  assert.equal(first.passed, true);
  await rm(f.input);
  await symlink("target", f.input);
  await assert.rejects(f.tracker.check(id, prepared.attempt,
    { command: process.execPath, args: ["-e", ""] }), { code: "scope" });
  await rm(f.input);
  await writeFile(f.input, "initial source");
  assert.equal((await f.tracker.issue(id)).status, "in_progress");
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
});

test("an unmet dependency rejects preparation without claiming downstream work", async t => {
  const f = await fixture(t);
  const parent = await f.create();
  const child = await f.create([parent]);
  await assert.rejects(f.tracker.prepare(child), error => error instanceof WorkError && error.code === "blocked");
  assert.equal((await f.tracker.issue(child)).status, "open");
});

test("concurrent sessions cannot both prepare the same work", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const other = createWorkTracker({ cwd, actor: "another-session" });
  const attempts = await Promise.allSettled([f.tracker.prepare(id), other.prepare(id)]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await f.tracker.issue(id)).status, "hooked");
});

test("one prepared attempt can authorize only one dispatch", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  const launches = await Promise.allSettled([
    f.tracker.beginDispatch(id, prepared.attempt), f.tracker.beginDispatch(id, prepared.attempt),
  ]);
  assert.equal(launches.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await f.tracker.issue(id)).status, "in_progress");
});

test("changed prerequisite source invalidates downstream dispatch", async t => {
  const f = await fixture(t);
  const parent = await f.create();
  const attempt = await f.tracker.prepare(parent, { mode: "direct" });
  const proof = await f.tracker.check(parent, attempt.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  });
  assert.equal(proof.passed, true);
  await f.tracker.accept(parent, attempt.attempt);
  const child = await f.create([parent]);
  const prepared = await f.tracker.prepare(child);
  await writeFile(f.input, "changed source");
  await assert.rejects(f.tracker.beginDispatch(child, prepared.attempt),
    error => error instanceof WorkError && error.code === "blocked");
  assert.equal((await f.tracker.issue(child)).status, "hooked");
});

test("failed checks and modified receipts cannot close work", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const failed = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(7)"],
  });
  assert.equal(failed.passed, false);
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
  const passed = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  });
  await writeFile(path.join(cwd, passed.receipt.path), "{}");
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
  assert.equal((await f.tracker.issue(id)).status, "in_progress");
});

test("another agent's finding appears in the bounded review packet", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const other = createWorkTracker({ cwd, actor: "investigator-session" });
  await other.note(id, { kind: "question", text: "Does the adapter preserve the caller's deadline?",
    source: "observed caller", observedAt: "2026-11-12T12:00:00Z" });
  const packet = await f.tracker.packet(id);
  assert.equal(packet.notes.length, 1);
  const note = packet.notes[0];
  assert.equal(note.session, "investigator-session");
  assert.equal(note.kind, "question");
});

test("directory additions invalidate acceptance and metadata survives transitions", async t => {
  const f = await fixture(t);
  const directory = path.dirname(f.input);
  const value = await f.tracker.create({ title: "Disposable directory proof", objective: "Track new files",
    paths: [path.relative(cwd, directory)] });
  t.after(() => exec("bd", ["--sandbox", "close", value.id, "--force"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 }));
  await exec("bd", ["--sandbox", "update", value.id, "--metadata", '{"unrelated":{"retained":true}}'],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
  const prepared = await f.tracker.prepare(value.id, { mode: "direct" });
  const proof = await f.tracker.check(value.id, prepared.attempt,
    { command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(proof.passed, true);
  await writeFile(path.join(directory, "new.txt"), "new source");
  await assert.rejects(f.tracker.accept(value.id, prepared.attempt), { code: "unverified" });
  assert.deepEqual((await f.tracker.issue(value.id)).metadata.unrelated, { retained: true });
});

test("expected nonzero checks preserve command failures and failed cleanup prevents acceptance", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const proof = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(7)"], expectedExitCodes: [7],
    cleanup: { command: process.execPath, args: ["-e", "process.exit(9)"] },
  });
  const manifest = JSON.parse(await readFile(path.join(cwd, proof.receipt.path), "utf8"));
  assert.equal(proof.passed, false);
  assert.equal(manifest.commands[0].code, 7);
  assert.equal(manifest.commands[1].code, 9);
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
});

test("recovery requires explicit stopped-owner confirmation and preserves the old attempt", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  await f.tracker.beginDispatch(id, prepared.attempt);
  await f.tracker.dispatched(id, prepared.attempt, {
    taskId: "st_recovery_fixture", nativeStatus: "running", outcome: "native-admitted",
  });
  const value = await f.tracker.issue(id);
  await assert.rejects(f.tracker.recover(id, { assignee: value.assignee, status: value.status,
    reason: "Interruption" }), { code: "recovery" });
  await f.tracker.recover(id, { assignee: value.assignee, status: value.status,
    reason: "Fixture owner has stopped. ".repeat(60), confirmedStopped: true });
  await assert.rejects(f.tracker.beginDispatch(id, prepared.attempt), { code: "ownership" });
  const packet = await f.tracker.packet(id);
  assert.equal(packet.status, "open");
  assert.equal(packet.notes[0].previousAttempt.id, prepared.attempt);
  assert.equal(packet.notes[0].truncated.text, true);
  assert.equal(packet.notes[0].previousDispatch.attemptId, prepared.attempt);
  assert.equal(packet.notes[0].previousDispatch.taskId, "st_recovery_fixture");
  assert.equal(packet.dispatch, undefined);
  assert.equal((await f.tracker.issue(id)).metadata.qrclipDispatch, null);
  const next = await f.tracker.prepare(id);
  assert.notEqual(next.attempt, prepared.attempt);
  assert.equal(next.packet.dispatch, undefined);
});

test("source scopes cannot traverse symlink ancestors", async t => {
  const f = await fixture(t);
  await mkdir(path.join(path.dirname(f.input), "outside"));
  await writeFile(path.join(path.dirname(f.input), "outside", "file"), "content");
  await symlink(path.join(path.dirname(f.input), "outside"), path.join(path.dirname(f.input), "alias"));
  const value = await f.tracker.create({ title: "Disposable symlink proof", objective: "Reject ancestor symlinks",
    paths: [path.relative(cwd, path.join(path.dirname(f.input), "alias", "file"))] });
  t.after(() => exec("bd", ["--sandbox", "close", value.id, "--force"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 }));
  await assert.rejects(f.tracker.prepare(value.id), { code: "scope" });
});

test("source changes between preparation and dispatch cannot launch work", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  await writeFile(f.input, "new revision");
  await assert.rejects(f.tracker.beginDispatch(id, prepared.attempt), { code: "stale-input" });
  assert.equal((await f.tracker.issue(id)).status, "hooked");
});

test("first-case build-only evidence cannot qualify for expansion", async t => {
  const f = await fixture(t);
  const id = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  await assert.rejects(f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  }), { code: "fixture-evidence" });
  await assert.rejects(f.tracker.accept(id, prepared.attempt, { review: firstCaseReview }),
    { code: "unverified" });
});

test("first-case contract simulation rejection inputs cannot qualify", async t => {
  const cases = [
    {
      name: "terminal failure",
      change(report) { report.passed = false; },
    },
    {
      name: "failed cleanup",
      change(report) { report.cleanup[0].passed = false; },
    },
    {
      name: "observation publication failure",
      async change(report, f) {
        const file = path.join(cwd, report.observation.manifestPath);
        const manifest = JSON.parse(await readFile(file, "utf8"));
        manifest.failures.publication.push({ message: "fixture publication failed" });
        await writeFile(file, JSON.stringify(manifest));
      },
    },
    {
      name: "stale source",
      async change(report, f) {
        await writeFile(f.input, "changed after report");
        return report;
      },
    },
    {
      name: "missing visual evidence",
      visual: true,
      change(report) { return report; },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async st => {
      const f = await fixture(st);
      const id = await f.create([], {
        fixture: { stage: "first-case", visual: scenario.visual ?? false },
      });
      const prepared = await f.tracker.prepare(id, { mode: "direct" });
      const evidence = await firstCaseEvidence(f, { visual: scenario.visual ?? false });
      const report = JSON.parse(await readFile(evidence.reportPath, "utf8"));
      await scenario.change(report, f);
      await writeFile(evidence.reportPath, JSON.stringify(report));
      const proof = await acceptFirstCase(f, id, prepared.attempt, {
        ...evidence,
        visualEvidence: scenario.name === "missing visual evidence" ? [] : evidence.visualEvidence,
      }, { expectedPassed: false });
      assert.equal(proof.passed, false);
      await assert.rejects(f.tracker.accept(id, prepared.attempt, { review: firstCaseReview }),
        { code: "unverified" });
    });
  }
});

test("a pre-existing success report cannot qualify a no-op check", async t => {
  const f = await fixture(t);
  const id = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  const proof = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    firstCase: { report: evidence.report, manifest: path.relative(cwd, evidence.manifestPath), visualEvidence: [] },
  });
  assert.equal(proof.passed, false);
  await assert.rejects(f.tracker.accept(id, prepared.attempt, { review: firstCaseReview }),
    { code: "unverified" });
});

test("a prior check-bound report cannot be replayed by a later no-op check", async t => {
  const f = await fixture(t);
  const id = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  const first = await acceptFirstCase(f, id, prepared.attempt, evidence);
  assert.equal(first.passed, true);
  const replay = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    firstCase: { report: evidence.report, manifest: path.relative(cwd, evidence.manifestPath), visualEvidence: [] },
  });
  assert.equal(replay.passed, false);
  await assert.rejects(f.tracker.accept(id, prepared.attempt, { review: firstCaseReview }),
    { code: "unverified" });
});

test("first-case acceptance requires coordinator review and gates expansion", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  await assert.rejects(f.tracker.prepare(child, { mode: "direct" }), { code: "blocked" });
  await assert.rejects(f.tracker.prepare(child, { mode: "delegate" }), { code: "blocked" });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  assert.equal(attempt.hints.review.type, "string");
  assert.equal(attempt.hints.review.maxCharacters, 4000);
  assert.deepEqual(attempt.hints.noteKinds, ["finding", "question", "decision", "constraint"]);
  const evidence = await firstCaseEvidence(f, { visual: true });
  const proof = await acceptFirstCase(f, first, attempt.attempt, evidence);
  assert.equal(proof.passed, true);
  await assert.rejects(f.tracker.accept(first, attempt.attempt), { code: "fixture-review" });
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const prepared = await f.tracker.prepare(child, { mode: "delegate" });
  await f.tracker.beginDispatch(child, prepared.attempt);
  assert.equal((await f.tracker.issue(child)).status, "in_progress");
});

test("expansion admission checks fresh source and artifacts before dispatch", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child, { mode: "delegate" });
  await writeFile(f.input, "source changed before expansion admission");
  await assert.rejects(f.tracker.beginDispatch(child, prepared.attempt), { code: "blocked" });
  assert.equal((await f.tracker.issue(child)).status, "hooked");
});

test("admitted expansion tolerates planned source edits but protects evidence", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child, { mode: "direct" });
  await writeFile(f.input, "planned expansion source edit");
  const proof = await f.tracker.check(child, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  });
  assert.equal(proof.passed, true);
  await f.tracker.accept(child, prepared.attempt);
  assert.equal((await f.tracker.issue(child)).status, "closed");
});

test("tampered artifacts keep expansion blocked after admission", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f, { visual: true });
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child, { mode: "direct" });
  await writeFile(evidence.pngPath, Buffer.from("tampered image artifact"));
  await assert.rejects(f.tracker.check(child, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  }), { code: "blocked" });
  assert.equal((await f.tracker.issue(child)).status, "blocked");
});

test("reopening an accepted first case blocks a prepared expansion", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child, { mode: "delegate" });
  await exec("bd", ["--sandbox", "update", first, "--status", "open", "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
  await assert.rejects(f.tracker.beginDispatch(child, prepared.attempt), { code: "blocked" });
  assert.equal((await f.tracker.issue(child)).status, "hooked");
});

test("fixture classification survives explicit recovery", async t => {
  const f = await fixture(t);
  const id = await f.create([], { fixture: { stage: "first-case", visual: true } });
  await f.tracker.prepare(id, { mode: "direct" });
  const observed = await f.tracker.issue(id);
  await assert.rejects(f.tracker.edit(id, { fixture: { stage: "first-case", visual: false } }),
    { code: "state" });
  await f.tracker.recover(id, { assignee: observed.assignee, status: observed.status,
    confirmedStopped: true, reason: "No command or worker was started by this contract fixture." });
  assert.deepEqual((await f.tracker.packet(id)).fixture, { stage: "first-case", visual: true });
});

test("organization changes preserve active and accepted work proof", async t => {
  const f = await fixture(t);
  const parent = await f.create([], { type: "epic" });
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
  });
  const before = (await f.tracker.issue(id)).metadata.qrclipWork;
  await f.tracker.edit(id, { parent, labels: ["omo-work", "source-ready", "needs-platform-proof"] });
  const active = await f.tracker.issue(id);
  assert.deepEqual(active.metadata.qrclipWork, before);
  assert(active.dependencies.some(dependency => dependency.id === parent &&
    dependency.dependency_type === "parent-child"));
  assert(active.labels.includes("needs-platform-proof"));
  await f.tracker.accept(id, prepared.attempt);
  const accepted = (await f.tracker.issue(id)).metadata.qrclipWork;
  await f.tracker.edit(id, { labels: ["omo-work", "accepted"] });
  assert.deepEqual((await f.tracker.issue(id)).metadata.qrclipWork, accepted);
});

test("the dispatcher creates edits and reads authoritative work with the caller identity", async t => {
  const f = await fixture(t);
  const tracker = createWorkTracker({ cwd, actor: "cli-fixture" });
  const dispatch = (operation, input) => runWorkCommand(tracker, operation, input);
  const created = await dispatch("create", { title: "Disposable dispatcher fixture",
    objective: "Prove the named dispatcher boundary", paths: [] });
  f.track(created.id);
  await dispatch("edit", { id: created.id, acceptance: "Explicit dispatcher acceptance" });
  await dispatch("note", { id: created.id, kind: "finding", text: "A dispatcher observation" });
  const packet = await dispatch("packet", { id: created.id });
  assert.equal(packet.acceptance, "Explicit dispatcher acceptance");
  assert.equal(packet.notes[0].session, "cli-fixture");
  assert.equal((await f.tracker.issue(created.id)).title, "Disposable dispatcher fixture");
  await assert.rejects(dispatch("unknown", {}), { code: "operation" });
});

test("cleanup source mutation leaves the check receipt failing", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const checked = await f.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", "process.exit(0)"],
    cleanup: { command: process.execPath,
      args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], "cleanup mutation")', f.input] },
  });
  const manifest = JSON.parse(await readFile(path.join(cwd, checked.receipt.path), "utf8"));
  assert.equal(checked.passed, false);
  assert.equal(manifest.status, "failed");
  await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
});

async function gatedTracker(t, f, mode, name = "") {
  const directory = path.dirname(f.input);
  const binary = path.join(directory, `${name}bd-proxy`);
  const ready = path.join(directory, `${name}accept-ready`);
  const release = path.join(directory, `${name}accept-release`);
  await symlink(path.join(packageRoot, "test", "agent-work-test-bd.mjs"), binary);
  await writeFile(binary + ".json", JSON.stringify({ mode, ready, release }));
  const watcher = watch(directory);
  let timer;
  const reached = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Tracker did not reach ${mode} boundary`)), 10000);
    watcher.on("change", (_event, filename) => {
      if (filename === path.basename(ready)) resolve();
    });
    watcher.on("error", reject);
  }).finally(() => { clearTimeout(timer); watcher.close(); });
  // Each caller releases and joins the operation in finally before fixture cleanup.
  return {
    tracker: createWorkTracker({ cwd, actor: "contract-test", binary }),
    reached, ready, release: () => writeFile(release, "release"),
  };
}

test("lost check-release response cannot clear a newer check owner", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const firstGate = await gatedTracker(t, f, "committed-release", "first-");
  const nextGate = await gatedTracker(t, f, "checked-update", "next-");
  const first = firstGate.tracker.check(id, prepared.attempt,
    { command: process.execPath, args: ["-e", ""] }).then(value => ({ value }), error => ({ error }));
  let next;
  try {
    const firstBoundary = await Promise.race([firstGate.reached.then(() => ({ reached: true })), first]);
    if (firstBoundary.error) throw firstBoundary.error;
    assert.equal(firstBoundary.reached, true, "first check returned before release boundary");
    next = nextGate.tracker.check(id, prepared.attempt,
      { command: process.execPath, args: ["-e", ""] }).then(value => ({ value }), error => ({ error }));
    const nextBoundary = await Promise.race([nextGate.reached.then(() => ({ reached: true })), next]);
    if (nextBoundary.error) throw nextBoundary.error;
    assert.equal(nextBoundary.reached, true, "second check returned before publication boundary");
    const owner = (await f.tracker.issue(id)).assignee;
    await firstGate.release();
    assert.ok((await first).error instanceof AggregateError);
    const active = await f.tracker.issue(id);
    assert.equal(active.status, "blocked");
    assert.equal(active.assignee, owner);
    await nextGate.release();
    assert.equal((await next).value.passed, true);
  } finally {
    await firstGate.release();
    await nextGate.release();
    await first;
    if (next) await next;
  }
});

test("proof publication crossing the deadline cannot release a passing check", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const gate = await gatedTracker(t, f, "checked-update");
  const deadline = performance.now() + 8000;
  const checking = gate.tracker.check(id, prepared.attempt, {
    command: process.execPath, args: ["-e", ""], budgetMs: 8000,
  }).then(value => ({ value }), error => ({ error }));
  try {
    const boundary = await Promise.race([gate.reached.then(() => ({ reached: true })), checking]);
    if (boundary.error) throw boundary.error;
    assert.equal(boundary.reached, true, "check returned before the publication boundary");
    const candidate = JSON.parse(await readFile(gate.ready, "utf8"));
    assert.equal(candidate.qrclipWork.checked.passed, true);
    assert.equal((await f.tracker.issue(id)).status, "blocked");
    // Time is the subject of this test: release only after the check's deadline.
    await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - performance.now() + 20)));
    await gate.release();
    const result = await checking;
    assert.equal(result.error, undefined);
    assert.equal(result.value.passed, false);
    assert.equal((await f.tracker.issue(id)).metadata.qrclipWork.checked.passed, false);
    await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
  } finally {
    await gate.release();
    await checking;
  }
});

test("acceptance cannot overwrite a newer failed check after status and assignee return", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  await f.tracker.check(id, prepared.attempt, { command: process.execPath, args: ["-e", "process.exit(0)"] });
  const gate = await gatedTracker(t, f, "first-update");
  const accepting = gate.tracker.accept(id, prepared.attempt).then(
    value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const failed = await f.tracker.check(id, prepared.attempt,
      { command: process.execPath, args: ["-e", "process.exit(7)"] });
    assert.equal(failed.passed, false);
    await gate.release();
    const result = await accepting;
    assert.equal(result.error?.code, "unverified");
    const observed = await f.tracker.issue(id);
    assert.equal(observed.status, "in_progress");
    assert.equal(observed.metadata.qrclipWork.checked.receipt.sha256, failed.receipt.sha256);
    assert.equal(observed.metadata.qrclipWork.accepted, undefined);
  } finally {
    await gate.release();
    await accepting;
  }
});

test("acceptance holding its exclusive transition excludes another actor's check", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const checked = await f.tracker.check(id, prepared.attempt,
    { command: process.execPath, args: ["-e", "process.exit(0)"] });
  const gate = await gatedTracker(t, f, "close-update");
  const accepting = gate.tracker.accept(id, prepared.attempt).then(
    value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const other = createWorkTracker({ cwd, actor: "other-check-actor" });
    await assert.rejects(other.check(id, prepared.attempt,
      { command: process.execPath, args: ["-e", "process.exit(7)"] }), { code: "ownership" });
    await gate.release();
    assert.deepEqual((await accepting).value, { id, accepted: true });
    const observed = await f.tracker.issue(id);
    assert.equal(observed.metadata.qrclipWork.accepted.receipt.sha256, checked.receipt.sha256);
  } finally {
    await gate.release();
    await accepting;
  }
});

test("long packet notes preserve structured provenance and explicit field truncation", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const other = createWorkTracker({ cwd, actor: "long-note-investigator" });
  const text = "Finding ".repeat(500);
  const source = "source-ref".repeat(100);
  const note = await other.note(id, { kind: "finding", text, source, observedAt: "2026-11-12T12:00:00Z" });
  const packet = await f.tracker.packet(id);
  const observed = packet.notes[0];
  assert.equal(observed.session, "long-note-investigator");
  assert.equal(observed.text, text.slice(0, 1000));
  assert.equal(observed.source, source.slice(0, 512));
  assert.equal(observed.observedAt, note.observedAt);
  assert.equal(observed.recordedAt, note.recordedAt);
  assert.equal(observed.originalTextLength, text.length);
  assert.equal(observed.truncated.text, true);
  assert.equal(observed.truncated.source, true);
  assert.equal(observed.truncated.session, false);
  const retained = JSON.parse((await exec("bd", ["--sandbox", "comments", id, "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
  assert.equal(JSON.parse(retained[0].text).text, text);
  assert.equal(JSON.parse(retained[0].text).source, source);
});

test("history overflow exposes the read ceiling and preserves the backend failure cause", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const binary = path.join(path.dirname(f.input), "overflow-bd");
  await symlink(path.join(packageRoot, "test", "agent-work-test-bd.mjs"), binary);
  await writeFile(binary + ".json", JSON.stringify({ mode: "overflow-comments" }));
  const tracker = createWorkTracker({ cwd, actor: "history-contract", binary });
  await assert.rejects(tracker.packet(id), error => error.code === "history-limit" &&
    error.cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  const result = await runWorkCommand(f.tracker, "limits", {});
  assert.equal(result.readByteLimit, 2 * 1024 * 1024);
  assert.equal((await f.tracker.issue(id)).status, "open");
});

test("a delayed dispatch receipt cannot restore a passing proof over a newer failed check", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  await f.tracker.beginDispatch(id, prepared.attempt);
  await f.tracker.check(id, prepared.attempt, { command: process.execPath, args: ["-e", "process.exit(0)"] });
  await exec("bd", ["--sandbox", "update", id, "--metadata", '{"unrelated":{"retained":true}}'],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
  const gate = await gatedTracker(t, f, "first-update");
  const publishing = gate.tracker.dispatched(id, prepared.attempt, {
    taskId: "st_delayed_receipt", nativeStatus: "running", outcome: "native-admitted",
  }).then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const failed = await f.tracker.check(id, prepared.attempt,
      { command: process.execPath, args: ["-e", "process.exit(7)"] });
    assert.equal(failed.passed, false);
    const latestWork = (await f.tracker.issue(id)).metadata.qrclipWork;
    await gate.release();
    const result = await publishing;
    assert.equal(result.error, undefined);
    const observed = await f.tracker.issue(id);
    assert.equal(observed.metadata.qrclipWork.checked.passed, false);
    assert.deepEqual(observed.metadata.qrclipWork, latestWork);
    assert.deepEqual(observed.metadata.unrelated, { retained: true });
    assert.equal(observed.metadata.qrclipDispatch.attemptId, prepared.attempt);
    assert.equal(observed.metadata.qrclipDispatch.taskId, "st_delayed_receipt");
    await assert.rejects(f.tracker.accept(id, prepared.attempt), { code: "unverified" });
  } finally {
    await gate.release();
    await publishing;
  }
});

test("a delayed duplicate publisher cannot overwrite the winning attempt receipt", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  await f.tracker.beginDispatch(id, prepared.attempt);
  const gate = await gatedTracker(t, f, "first-update");
  const publishing = gate.tracker.dispatched(id, prepared.attempt, { taskId: "st_first_receipt_fixture" })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const winner = await f.tracker.dispatched(id, prepared.attempt, { taskId: "st_second_receipt_fixture" });
    await gate.release();
    assert.equal((await publishing).error?.code, "state");
    const observed = await f.tracker.issue(id);
    assert.deepEqual(observed.metadata.qrclipDispatch, winner);
    assert.equal(observed.metadata.qrclipDispatch.attemptId, prepared.attempt);
  } finally {
    await gate.release();
    await publishing;
  }
});

test("check and acceptance metadata merges retain the independent dispatch receipt", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id);
  await f.tracker.beginDispatch(id, prepared.attempt);
  const receipt = await f.tracker.dispatched(id, prepared.attempt, {
    taskId: "st_merge_fixture", error: null, nativeStatus: "running", outcome: "native-admitted",
  });
  const packet = await f.tracker.packet(id);
  assert.equal(packet.dispatch.attemptId, prepared.attempt);
  assert.equal(packet.dispatch.taskId, "st_merge_fixture");
  const checked = await f.tracker.check(id, prepared.attempt,
    { command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(checked.passed, true);
  await f.tracker.accept(id, prepared.attempt);
  const observed = await f.tracker.issue(id);
  assert.equal(observed.status, "closed");
  assert.deepEqual(observed.metadata.qrclipDispatch, receipt);
  assert.deepEqual(observed.metadata.qrclipWork.accepted, checked);
});

test("explicit first-case refresh archives proof and requires fresh execution and review", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  await f.tracker.note(first, { kind: "finding", text: "Retain this prior observation." });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const dispatch = await f.tracker.dispatched(first, attempt.attempt, { taskId: "st_archived_receipt" });
  const evidence = await firstCaseEvidence(f, { visual: true });
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child);
  const previous = await f.tracker.issue(first);
  const paths = [previous.metadata.qrclipWork.accepted.receipt.path,
    ...Object.keys(previous.metadata.qrclipWork.accepted.firstCase.artifacts)];
  const originals = await Promise.all(paths.map(file => readFile(path.join(cwd, file))));
  await writeFile(f.input, "new source revision requiring refreshed proof");

  const packet = await runWorkCommand(f.tracker, "recover", { id: first,
    operation: "refresh-first-case", assignee: previous.assignee, status: "closed",
    confirmedStopped: true, reason: "Source changed; execute a fresh first case." });

  assert.equal(packet.status, "open");
  const reset = await f.tracker.issue(first);
  assert.equal(reset.assignee || "", "");
  assert.equal(reset.metadata.qrclipWork.accepted, undefined);
  assert.equal(reset.metadata.qrclipWork.checked, undefined);
  assert.equal(reset.metadata.qrclipWork.attempt, undefined);
  const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", first, "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
  assert.equal(JSON.parse(comments[0].text).text, "Retain this prior observation.");
  const archive = JSON.parse(comments.at(-1).text);
  assert.equal(archive.operation, "refresh-first-case");
  assert.deepEqual(archive.previous, previous.metadata.qrclipWork);
  assert.deepEqual(archive.previousDispatch, dispatch);
  assert.match(archive.transitionOwner, /^omo:recovery:/);
  for (let index = 0; index < paths.length; index++)
    assert.deepEqual(await readFile(path.join(cwd, paths[index])), originals[index]);
  await assert.rejects(f.tracker.beginDispatch(child, prepared.attempt), { code: "blocked" });
  const next = await f.tracker.prepare(first, { mode: "direct" });
  assert.notEqual(next.attempt, attempt.attempt);
  await assert.rejects(f.tracker.accept(first, next.attempt, { review: firstCaseReview }),
    { code: "unverified" });
  await assert.rejects(acceptFirstCase(f, first, next.attempt, evidence), { code: "fixture-evidence" });
  const freshEvidence = await firstCaseEvidence(f, { visual: true, prefix: "fresh-" });
  const replay = await f.tracker.check(first, next.attempt, {
    command: process.execPath, args: ["-e", ""],
    firstCase: { report: freshEvidence.report, manifest: path.relative(cwd, freshEvidence.manifestPath),
      visualEvidence: freshEvidence.visualEvidence },
  });
  assert.equal(replay.passed, false);
  const checked = await acceptFirstCase(f, first, next.attempt, freshEvidence);
  assert.equal(checked.passed, true);
  await assert.rejects(f.tracker.accept(first, next.attempt), { code: "fixture-review" });
  await f.tracker.accept(first, next.attempt, { review: firstCaseReview });
  await assert.rejects(f.tracker.beginDispatch(child, prepared.attempt), { code: "stale-input" });
  for (let index = 0; index < paths.length; index++)
    assert.deepEqual(await readFile(path.join(cwd, paths[index])), originals[index]);
});

test("special recovery rejects wrong confirmation, classification, state and tampered proof", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const prepared = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f, { visual: true });
  await acceptFirstCase(f, first, prepared.attempt, evidence);
  await f.tracker.accept(first, prepared.attempt, { review: firstCaseReview });
  const previous = await f.tracker.issue(first);
  const options = { assignee: previous.assignee, status: "closed",
    reason: "Refresh stale proof.", confirmedStopped: true, operation: "refresh-first-case" };
  await assert.rejects(f.tracker.recover(first, options), { code: "recovery" });
  await writeFile(f.input, "stale source");
  for (const changed of [
    { confirmedStopped: false }, { reason: "   " }, { assignee: "different-owner" },
    { status: "in_progress" }, { operation: "cancel-expansion" }, { operation: "unknown" },
    { operation: undefined },
  ])
    await assert.rejects(f.tracker.recover(first, { ...options, ...changed }), { code: "recovery" });
  const png = await readFile(evidence.pngPath);
  await writeFile(evidence.pngPath, "tampered artifact");
  await assert.rejects(f.tracker.recover(first, options), { code: "recovery" });
  await writeFile(evidence.pngPath, png);
  const receiptPath = path.join(cwd, previous.metadata.qrclipWork.accepted.receipt.path);
  const receipt = await readFile(receiptPath);
  await writeFile(receiptPath, "{}");
  await assert.rejects(f.tracker.recover(first, options), { code: "recovery" });
  await writeFile(receiptPath, receipt);
  assert.deepEqual((await f.tracker.issue(first)).metadata, previous.metadata);
  assert.equal((await f.tracker.issue(first)).status, "closed");

  const ordinary = await f.create();
  const attempt = await f.tracker.prepare(ordinary, { mode: "direct" });
  await f.tracker.check(ordinary, attempt.attempt, { command: process.execPath, args: ["-e", ""] });
  await f.tracker.accept(ordinary, attempt.attempt);
  const closed = await f.tracker.issue(ordinary);
  await assert.rejects(f.tracker.recover(ordinary, { ...options, assignee: closed.assignee }),
    { code: "recovery" });
  assert.equal((await f.tracker.issue(ordinary)).status, "closed");
});

test("cancelled undispatched expansion is archived closed and cannot admit dependent work", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, firstAttempt.attempt, evidence);
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const attempt = await f.tracker.prepare(child);
  const previous = await f.tracker.issue(child);

  const result = await runWorkCommand(f.tracker, "recover", {
    id: child, assignee: previous.assignee, status: previous.status,
    reason: "Undispatched expansion is no longer needed.", confirmedStopped: true,
    operation: "cancel-expansion",
  });

  assert.equal(result.status, "closed");
  const cancelled = await f.tracker.issue(child);
  assert.equal(cancelled.assignee || "", "");
  assert.equal(cancelled.metadata.qrclipWork.cancelled.attempt, attempt.attempt);
  assert.equal(cancelled.metadata.qrclipWork.accepted, undefined);
  assert.equal(cancelled.metadata.qrclipDispatch, null);
  const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", child, "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
  assert.deepEqual(JSON.parse(comments.at(-1).text).previous, previous.metadata.qrclipWork);
  await assert.rejects(f.tracker.accept(child, attempt.attempt), { code: "ownership" });
  await assert.rejects(f.tracker.prepare(child), { code: "state" });
  await assert.rejects(f.tracker.beginDispatch(child, attempt.attempt), { code: "ownership" });
  const downstream = await f.create([child]);
  await assert.rejects(f.tracker.prepare(downstream), { code: "blocked" });
});

test("expansion cancellation refuses active dispatch, receipt, check and transition owners", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child);
  const refuse = async () => {
    const value = await f.tracker.issue(child);
    await assert.rejects(f.tracker.recover(child, { operation: "cancel-expansion",
      assignee: value.assignee, status: value.status, confirmedStopped: true,
      reason: "Cannot cancel work that has started." }), { code: "recovery" });
  };
  await f.tracker.beginDispatch(child, prepared.attempt);
  await refuse();
  await f.tracker.dispatched(child, prepared.attempt, { taskId: "st_cancellation_receipt" });
  await refuse();
  await f.tracker.check(child, prepared.attempt, { command: process.execPath, args: ["-e", ""] });
  await refuse();
  const gate = await gatedTracker(t, f, "close-update");
  const accepting = gate.tracker.accept(child, prepared.attempt)
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    await refuse();
    await gate.release();
    assert.equal((await accepting).value.accepted, true);
  } finally {
    await gate.release();
    await accepting;
  }
});

test("cancellation and dispatch reservation have exactly one winner", async t => {
  for (const delayed of ["dispatch", "cancel"]) {
    await t.test(delayed, async st => {
      const f = await fixture(st);
      const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
      const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
      await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
      await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
      const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
      const prepared = await f.tracker.prepare(child);
      const value = await f.tracker.issue(child);
      const gate = await gatedTracker(st, f, "first-update");
      const cancel = tracker => tracker.recover(child, { operation: "cancel-expansion",
        assignee: value.assignee, status: "hooked", confirmedStopped: true,
        reason: "Cancel only if dispatch has not reserved ownership." });
      const pending = (delayed === "dispatch" ? gate.tracker.beginDispatch(child, prepared.attempt)
        : cancel(gate.tracker)).then(value => ({ value }), error => ({ error }));
      try {
        await gate.reached;
        if (delayed === "dispatch") await cancel(f.tracker);
        else await f.tracker.beginDispatch(child, prepared.attempt);
        await gate.release();
        assert.ok((await pending).error);
        const observed = await f.tracker.issue(child);
        assert.equal(observed.status, delayed === "dispatch" ? "closed" : "in_progress");
        assert.equal(Boolean(observed.metadata.qrclipWork.cancelled), delayed === "dispatch");
      } finally {
        await gate.release();
        await pending;
      }
    });
  }
});

test("recovery rejects a proof changed across a same-owner status ABA", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const firstProof = await f.tracker.check(id, prepared.attempt,
    { command: process.execPath, args: ["-e", ""] });
  const old = await f.tracker.issue(id);
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.recover(id, { assignee: old.assignee, status: old.status,
    reason: "Observed old stopped state.", confirmedStopped: true })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const nextProof = await f.tracker.check(id, prepared.attempt,
      { command: process.execPath, args: ["-e", "process.exit(7)"] });
    assert.notEqual(nextProof.receipt.sha256, firstProof.receipt.sha256);
    await gate.release();
    assert.equal((await pending).error?.code, "recovery");
    const protectedValue = await f.tracker.issue(id);
    assert.equal(protectedValue.status, "blocked");
    assert.match(protectedValue.assignee, /^omo:recovery:/);
    assert.deepEqual(protectedValue.metadata.qrclipWork.checked, nextProof);
  } finally {
    await gate.release();
    await pending;
  }
});

test("first-case refresh revalidates artifacts after acquiring its unique owner", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f, { visual: true });
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const previous = await f.tracker.issue(first);
  await writeFile(f.input, "stale source");
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.recover(first, { operation: "refresh-first-case",
    assignee: previous.assignee, status: "closed", reason: "Refresh observed stale source.",
    confirmedStopped: true }).then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    await writeFile(evidence.pngPath, "artifact changed while reservation was pending");
    await gate.release();
    assert.equal((await pending).error?.code, "recovery");
    const protectedValue = await f.tracker.issue(first);
    assert.equal(protectedValue.status, "blocked");
    assert.deepEqual(protectedValue.metadata.qrclipWork.accepted, previous.metadata.qrclipWork.accepted);
  } finally {
    await gate.release();
    await pending;
  }
});

test("a delayed expansion reservation cannot dispatch after first-case refresh", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, attempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const prepared = await f.tracker.prepare(child);
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.beginDispatch(child, prepared.attempt)
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const previous = await f.tracker.issue(first);
    await writeFile(f.input, "stale source");
    await f.tracker.recover(first, { operation: "refresh-first-case",
      assignee: previous.assignee, status: "closed", confirmedStopped: true,
      reason: "Refresh before expansion can reserve." });
    await gate.release();
    assert.equal((await pending).error?.code, "blocked");
    assert.equal((await f.tracker.issue(child)).status, "hooked");
  } finally {
    await gate.release();
    await pending;
  }
});

test("late check acceptance and receipt reservations cannot mutate refreshed attempts", async t => {
  for (const operation of ["check", "accept", "receipt"]) {
    await t.test(operation, async st => {
      const f = await fixture(st);
      const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
      const attempt = await f.tracker.prepare(first, { mode: "direct" });
      const evidence = await firstCaseEvidence(f);
      await acceptFirstCase(f, first, attempt.attempt, evidence);
      const gate = await gatedTracker(st, f, "first-update");
      const call = operation === "check"
        ? acceptFirstCase({ ...f, tracker: gate.tracker }, first, attempt.attempt, evidence)
        : operation === "accept"
          ? gate.tracker.accept(first, attempt.attempt, { review: firstCaseReview })
          : gate.tracker.dispatched(first, attempt.attempt, { taskId: "st_late_old_receipt" });
      const pending = call.then(value => ({ value }), error => ({ error }));
      try {
        await gate.reached;
        await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
        const previous = await f.tracker.issue(first);
        await writeFile(f.input, "stale source");
        await f.tracker.recover(first, { operation: "refresh-first-case",
          assignee: previous.assignee, status: "closed", confirmedStopped: true,
          reason: "Fresh first-case execution is required." });
        const next = await f.tracker.prepare(first, { mode: "direct" });
        const protectedValue = await f.tracker.issue(first);
        await gate.release();
        assert.ok((await pending).error);
        const latest = await f.tracker.issue(first);
        assert.equal(latest.metadata.qrclipWork.attempt.id, next.attempt);
        assert.deepEqual(latest.metadata, protectedValue.metadata);
        assert.equal(latest.status, "in_progress");
      } finally {
        await gate.release();
        await pending;
      }
    });
  }
});

test("open expansion with closed source-stale prerequisite cancels with explicit null owner", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  await writeFile(f.input, "closed first-case proof now has stale source");
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  await f.tracker.note(child, { kind: "finding", text: "Preparation was refused before an owner existed." });
  await assert.rejects(f.tracker.prepare(child), { code: "blocked" });
  const previous = await f.tracker.issue(child);
  assert.equal(previous.status, "open");
  assert.ok(previous.assignee == null || previous.assignee === "");
  assert.equal(previous.metadata.qrclipWork.attempt, undefined);

  const result = await runWorkCommand(f.tracker, "recover", { id: child,
    operation: "cancel-expansion", assignee: null, status: "open", confirmedStopped: true,
    reason: "Cancel the expansion whose preparation was refused." });

  assert.equal(result.status, "closed");
  assert.equal(result.cancelled.attempt, null);
  const cancelled = await f.tracker.issue(child);
  assert.ok(cancelled.assignee == null || cancelled.assignee === "");
  assert.deepEqual(cancelled.metadata.qrclipWork.fixture, previous.metadata.qrclipWork.fixture);
  assert.deepEqual(cancelled.dependencies, previous.dependencies);
  assert.equal(cancelled.metadata.qrclipWork.accepted, undefined);
  assert.equal(cancelled.metadata.qrclipWork.checked, undefined);
  assert.equal(cancelled.metadata.qrclipWork.attempt, undefined);
  const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", child, "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
  assert.equal(comments.length, 2);
  assert.equal(JSON.parse(comments[0].text).text, "Preparation was refused before an owner existed.");
  const archive = JSON.parse(comments[1].text);
  assert.equal(archive.assignee, null);
  assert.equal(archive.status, "open");
  assert.deepEqual(archive.previous, previous.metadata.qrclipWork);
  assert.equal(archive.previousDispatch, null);
  await assert.rejects(f.tracker.prepare(child), { code: "state" });
  const downstream = await f.create([child]);
  await assert.rejects(f.tracker.prepare(downstream), { code: "blocked" });
});

test("open cancellation requires an explicit unassigned observation and pristine attempt state", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const previous = await f.tracker.issue(child);
  const options = { operation: "cancel-expansion", assignee: null, status: "open",
    confirmedStopped: true, reason: "Cancel only undispatched expansion work." };
  for (const changed of [
    { assignee: "" }, { assignee: undefined }, { assignee: "fabricated-owner" },
    { status: "hooked" }, { confirmedStopped: false }, { reason: " " },
    { operation: "refresh-first-case" },
  ])
    await assert.rejects(f.tracker.recover(child, { ...options, ...changed }), { code: "recovery" });
  // Each malformed state is confined to this disposable issue and reset before
  // staging the next boundary; no real operation or owner is being cancelled.
  for (const metadata of [
    { qrclipWork: { ...previous.metadata.qrclipWork, attempt: { id: "old-attempt", mode: "delegate" } } },
    { qrclipWork: { ...previous.metadata.qrclipWork, checked: null } },
    { qrclipWork: { ...previous.metadata.qrclipWork, accepted: { passed: true } } },
    { qrclipDispatch: { attemptId: "old-attempt", taskId: "st_existing_receipt" } },
  ]) {
    await exec("bd", ["--sandbox", "update", child, "--metadata", JSON.stringify(metadata)],
      { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
    await assert.rejects(f.tracker.recover(child, options), { code: "recovery" });
    const protectedValue = await f.tracker.issue(child);
    assert.equal(protectedValue.status, "open");
    assert.ok(protectedValue.assignee == null || protectedValue.assignee === "");
    await exec("bd", ["--sandbox", "update", child, "--metadata",
      JSON.stringify({ qrclipWork: previous.metadata.qrclipWork, qrclipDispatch: null })],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
  }
  const ordinary = await f.create();
  await assert.rejects(f.tracker.recover(ordinary, options), { code: "recovery" });
  await assert.rejects(f.tracker.recover(first, options), { code: "recovery" });
});

test("open cancellation and concurrent prepare cannot both reserve the empty owner", async t => {
  for (const delayed of ["prepare", "cancel"]) {
    await t.test(delayed, async st => {
      const f = await fixture(st);
      const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
      const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
      await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
      await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
      const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
      const gate = await gatedTracker(st, f, "first-update");
      const cancel = tracker => tracker.recover(child, { operation: "cancel-expansion",
        assignee: null, status: "open", confirmedStopped: true,
        reason: "Cancel only while preparation has not claimed the empty owner." });
      const pending = (delayed === "prepare" ? gate.tracker.prepare(child) : cancel(gate.tracker))
        .then(value => ({ value }), error => ({ error }));
      try {
        await gate.reached;
        const winner = delayed === "prepare" ? await cancel(f.tracker) : await f.tracker.prepare(child);
        await gate.release();
        assert.ok((await pending).error);
        const value = await f.tracker.issue(child);
        assert.equal(value.status, delayed === "prepare" ? "closed" : "hooked");
        if (delayed === "prepare") {
          assert.equal(winner.cancelled.attempt, null);
          assert.equal(value.metadata.qrclipWork.attempt, undefined);
          assert.ok(value.assignee == null || value.assignee === "");
          const downstream = await f.create([child]);
          await assert.rejects(f.tracker.prepare(downstream), { code: "blocked" });
        } else {
          assert.equal(value.assignee, "omo:" + winner.attempt);
          assert.equal(value.metadata.qrclipWork.attempt.id, winner.attempt);
          assert.equal(value.metadata.qrclipWork.cancelled, undefined);
        }
      } finally {
        await gate.release();
        await pending;
      }
    });
  }
});

test("open cancellation rejects metadata changed before its exclusive reservation", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const previous = await f.tracker.issue(child);
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.recover(child, { operation: "cancel-expansion",
    assignee: null, status: "open", confirmedStopped: true,
    reason: "Cancel the observed pristine expansion." })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const changed = { ...previous.metadata.qrclipWork, checked: null };
    await exec("bd", ["--sandbox", "update", child, "--metadata", JSON.stringify({ qrclipWork: changed })],
      { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
    await gate.release();
    assert.equal((await pending).error?.code, "recovery");
    const protectedValue = await f.tracker.issue(child);
    assert.equal(protectedValue.status, "blocked");
    assert.match(protectedValue.assignee, /^omo:recovery:/);
    assert.deepEqual(protectedValue.metadata.qrclipWork, changed);
    assert.equal(protectedValue.metadata.qrclipWork.cancelled, undefined);
  } finally {
    await gate.release();
    await pending;
  }
});

test("cancellation close cannot overwrite a replacement check owner at the same blocked status", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
  const child = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const gate = await gatedTracker(t, f, "close-update");
  const nextGate = await gatedTracker(t, f, "checked-update", "replacement-");
  const pending = gate.tracker.recover(child, { operation: "cancel-expansion",
    assignee: null, status: "open", confirmedStopped: true,
    reason: "Cancel only under the reserved cancellation owner." })
    .then(value => ({ value }), error => ({ error }));
  let checking;
  try {
    await gate.reached;
    const reserved = await f.tracker.issue(child);
    assert.equal(reserved.status, "blocked");
    assert.match(reserved.assignee, /^omo:recovery:/);
    await f.tracker.recover(child, { assignee: reserved.assignee, status: reserved.status,
      confirmedStopped: true, reason: "Disposable fixture supersedes its parked cancellation." });
    const next = await f.tracker.prepare(child);
    await f.tracker.beginDispatch(child, next.attempt);
    checking = nextGate.tracker.check(child, next.attempt,
      { command: process.execPath, args: ["-e", ""] })
      .then(value => ({ value }), error => ({ error }));
    const boundary = await Promise.race([nextGate.reached.then(() => ({ reached: true })), checking]);
    if (boundary.error) throw boundary.error;
    assert.equal(boundary.reached, true);
    const replacement = await f.tracker.issue(child);
    assert.equal(replacement.status, "blocked");
    assert.notEqual(replacement.assignee, reserved.assignee);
    await gate.release();
    assert.equal((await pending).error?.code, 13);
    const latest = await f.tracker.issue(child);
    assert.equal(latest.status, "blocked");
    assert.equal(latest.assignee, replacement.assignee);
    assert.deepEqual(latest.metadata, replacement.metadata);
    assert.equal(latest.metadata.qrclipWork.cancelled, undefined);
    await nextGate.release();
    assert.equal((await checking).value.passed, true);
  } finally {
    await gate.release();
    await nextGate.release();
    await pending;
    if (checking) await checking;
  }
});

test("open Beads blockers and children reject cancellation before any reservation", async t => {
  for (const status of ["open", "hooked"]) {
    for (const relationship of ["blocker", "child"]) {
      await t.test(`${status} with open ${relationship}`, async st => {
        const f = await fixture(st);
        const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
        const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
        await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
        await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
        const target = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
        if (status === "hooked") await f.tracker.prepare(target);
        const related = relationship === "blocker" ? first : await f.create([], { parent: target });
        if (relationship === "blocker")
          await exec("bd", ["--sandbox", "update", related, "--status", "open"],
            { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
        const before = await f.tracker.issue(target);
        const history = (await exec("bd", ["--sandbox", "comments", target, "--json"],
          { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout;

        await assert.rejects(f.tracker.recover(target, { operation: "cancel-expansion",
          assignee: status === "open" ? null : before.assignee, status,
          confirmedStopped: true, reason: "Do not reserve cancellation with an open relationship." }),
        error => error.code === "recovery" && error.message.includes(related));

        const after = await f.tracker.issue(target);
        assert.equal(after.status, before.status);
        assert.equal(after.assignee, before.assignee);
        assert.equal(after.revision, before.revision);
        assert.deepEqual(after.metadata, before.metadata);
        assert.equal((await exec("bd", ["--sandbox", "comments", target, "--json"],
          { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout, history);
      });
    }
  }
});

test("a relationship reopened at normal closure restores only the exact cancellation reservation", async t => {
  for (const status of ["open", "hooked"]) {
    for (const relationship of ["blocker", "child"]) {
      await t.test(`${status} reopening ${relationship}`, async st => {
        const f = await fixture(st);
        const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
        const firstAttempt = await f.tracker.prepare(first, { mode: "direct" });
        await acceptFirstCase(f, first, firstAttempt.attempt, await firstCaseEvidence(f));
        await f.tracker.accept(first, firstAttempt.attempt, { review: firstCaseReview });
        const target = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
        if (status === "hooked") await f.tracker.prepare(target);
        const related = relationship === "blocker" ? first : await f.create([], { parent: target });
        if (relationship === "child")
          await exec("bd", ["--sandbox", "close", related, "--reason", "Closed disposable child before race"],
            { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
        const before = await f.tracker.issue(target);
        const gate = await gatedTracker(st, f, "close-update");
        const pending = gate.tracker.recover(target, { operation: "cancel-expansion",
          assignee: status === "open" ? null : before.assignee, status,
          confirmedStopped: true, reason: "Normal closure must still see closed relationships." })
          .then(value => ({ value }), error => ({ error }));
        try {
          await gate.reached;
          const reserved = await f.tracker.issue(target);
          assert.equal(reserved.status, "blocked");
          assert.match(reserved.assignee, /^omo:recovery:/);
          await exec("bd", ["--sandbox", "update", related, "--status", "open"],
            { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
          const reopened = await f.tracker.issue(related);
          assert.equal(reopened.id, related);
          assert.equal(reopened.status, "open");
          const boundaryTarget = await f.tracker.issue(target);
          assert.equal(boundaryTarget.assignee, reserved.assignee);
          assert.equal(boundaryTarget.status, "blocked");
          assert.ok(relationship === "child"
            ? (reopened.dependencies || []).some(item =>
              item.id === target && item.dependency_type === "parent-child")
            : (boundaryTarget.dependencies || []).some(item =>
              item.id === related && item.dependency_type === "blocks" && item.status === "open"));
          await gate.release();
          const result = await pending;
          st.diagnostic(JSON.stringify({ boundary: "normal-close-refusal", relationship,
            target, related, relatedStatus: reopened.status,
            code: result.error?.code, stderr: result.error?.stderr, stdout: result.error?.stdout }));
          assert.equal(result.error?.code, 1);
          const refusal = JSON.parse(result.error.stderr.trim().split("\n").at(-1));
          assert.equal(refusal.schema_version, 1);
          assert.deepEqual(refusal.failed, [{ id: target, error: relationship === "child"
            ? `updating issue: cannot close ${target}: 1 open child issue(s); close children first or use --force to override`
            : `updating issue: cannot close blocked issue: ${target} is blocked by [${related}]` }]);
          const after = await f.tracker.issue(target);
          assert.equal(after.status, before.status);
          assert.equal(after.assignee || "", before.assignee || "");
          assert.deepEqual(after.metadata, before.metadata);
          const retainedRelated = await f.tracker.issue(related);
          assert.equal(retainedRelated.id, related);
          assert.equal(retainedRelated.status, "open");
          const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", target, "--json"],
            { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
          assert.equal(comments.length, 1);
          assert.deepEqual(JSON.parse(comments[0].text).previous, before.metadata.qrclipWork);
        } finally {
          await gate.release();
          await pending;
        }
      });
    }
  }
});

test("reopening before reservation is rechecked and releases the untouched cancellation owner", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, attempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const target = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const before = await f.tracker.issue(target);
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.recover(target, { operation: "cancel-expansion",
    assignee: null, status: "open", confirmedStopped: true,
    reason: "Recheck relationships under the unique reservation." })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    await exec("bd", ["--sandbox", "update", first, "--status", "open"],
      { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
    await gate.release();
    const result = await pending;
    assert.equal(result.error?.code, "recovery");
    assert.ok(result.error.message.includes(first));
    const after = await f.tracker.issue(target);
    assert.equal(after.status, "open");
    assert.ok(after.assignee == null || after.assignee === "");
    assert.deepEqual(after.metadata, before.metadata);
    const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", target, "--json"],
      { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
    assert.equal(comments.length, 0);
  } finally {
    await gate.release();
    await pending;
  }
});

test("a lost successful cancellation response cannot reopen its closed state", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  await acceptFirstCase(f, first, attempt.attempt, await firstCaseEvidence(f));
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const target = await f.create([], { fixture: { stage: "expansion", firstCase: first } });
  const gate = await gatedTracker(t, f, "committed-close");
  const pending = gate.tracker.recover(target, { operation: "cancel-expansion",
    assignee: null, status: "open", confirmedStopped: true,
    reason: "Keep a committed cancellation closed even when its response is lost." })
    .then(value => ({ value }), error => ({ error }));
  try {
    const boundary = await Promise.race([gate.reached.then(() => ({ reached: true })), pending]);
    if (boundary.error) throw boundary.error;
    assert.equal(boundary.reached, true);
    const committed = await f.tracker.issue(target);
    assert.equal(committed.status, "closed");
    assert.equal(committed.metadata.qrclipWork.cancelled.attempt, null);
    await exec("bd", ["--sandbox", "update", first, "--status", "open"],
      { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 });
    await gate.release();
    assert.equal((await pending).error?.code, 1);
    const after = await f.tracker.issue(target);
    assert.equal(after.status, "closed");
    assert.ok(after.assignee == null || after.assignee === "");
    assert.deepEqual(after.metadata, committed.metadata);
    assert.equal(after.metadata.qrclipWork.accepted, undefined);
  } finally {
    await gate.release();
    await pending;
  }
});

test("prepare parked across accept and refresh cannot erase historical artifact ownership", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.prepare(first, { mode: "direct" })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const current = await f.tracker.prepare(first, { mode: "direct" });
    const evidence = await firstCaseEvidence(f, { visual: true });
    await acceptFirstCase(f, first, current.attempt, evidence);
    await f.tracker.accept(first, current.attempt, { review: firstCaseReview });
    const accepted = await f.tracker.issue(first);
    await writeFile(f.input, "source changed across the parked preparation");
    await f.tracker.recover(first, { operation: "refresh-first-case",
      assignee: accepted.assignee, status: "closed", confirmedStopped: true,
      reason: "Complete the actual acceptance and refresh ABA cycle." });
    const refreshed = await f.tracker.issue(first);
    assert.equal(refreshed.status, "open");
    assert.ok(refreshed.assignee == null || refreshed.assignee === "");
    assert.ok(refreshed.metadata.qrclipWork.retiredArtifacts.includes(
      path.relative(cwd, evidence.manifestPath)));
    await gate.release();
    assert.equal((await pending).error?.code, "stale-input");
    const retained = await f.tracker.issue(first);
    assert.equal(retained.status, "open");
    assert.ok(retained.assignee == null || retained.assignee === "");
    assert.deepEqual(retained.metadata, refreshed.metadata);
  } finally {
    await gate.release();
    await pending;
  }
});

test("fresh report and PNG reusing an old manifest preserve every historical artifact byte", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: true } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f, { visual: true });
  // Give the report and observation different bytes at the same basename.
  const otherDirectory = path.join(path.dirname(f.input), "observation");
  await mkdir(otherDirectory);
  const manifestPath = path.join(otherDirectory, path.basename(evidence.reportPath));
  await writeFile(manifestPath, await readFile(evidence.manifestPath));
  const oldReport = JSON.parse(await readFile(evidence.reportPath, "utf8"));
  oldReport.observation.manifestPath = path.relative(cwd, manifestPath);
  await writeFile(evidence.reportPath, JSON.stringify(oldReport));
  await acceptFirstCase(f, first, attempt.attempt, { ...evidence, manifestPath });
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const accepted = await f.tracker.issue(first);
  const proof = accepted.metadata.qrclipWork.accepted;
  const historicPaths = [proof.receipt.path, ...Object.keys(proof.firstCase.artifacts)].sort();
  const originals = Object.fromEntries(await Promise.all(historicPaths.map(async file =>
    [file, (await readFile(path.join(cwd, file))).toString("base64")])));
  await writeFile(f.input, "stale source before preserving historical artifact bytes");
  await f.tracker.recover(first, { operation: "refresh-first-case",
    assignee: accepted.assignee, status: "closed", confirmedStopped: true,
    reason: "Preserve all old evidence before the next command can reuse its manifest." });
  const refreshed = await f.tracker.issue(first);
  assert.equal(refreshed.metadata.qrclipWork.artifactArchives?.length, 1);
  const mapping = refreshed.metadata.qrclipWork.artifactArchives[0].artifacts;
  assert.deepEqual(Object.keys(mapping).sort(), historicPaths);
  assert.notEqual(mapping[evidence.report].path, mapping[path.relative(cwd, manifestPath)].path);
  for (const file of historicPaths) {
    assert.deepEqual(await readFile(path.join(cwd, mapping[file].path)), Buffer.from(originals[file], "base64"));
    assert.equal(mapping[file].sha256, createHash("sha256").update(Buffer.from(originals[file], "base64")).digest("hex"));
  }
  const comments = JSON.parse((await exec("bd", ["--sandbox", "comments", first, "--json"],
    { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
  const archive = JSON.parse(comments.at(-1).text);
  assert.deepEqual(archive.previous.accepted, proof);
  assert.deepEqual(archive.preservedArtifacts, mapping);

  const next = await f.tracker.prepare(first, { mode: "direct" });
  const freshEvidence = await firstCaseEvidence(f, { visual: true, prefix: "fresh-" });
  const report = JSON.parse(await readFile(freshEvidence.reportPath, "utf8"));
  report.observation.manifestPath = path.relative(cwd, manifestPath);
  await writeFile(freshEvidence.reportPath, JSON.stringify(report));
  const witness = path.join(path.dirname(freshEvidence.reportPath), "historic-preservation-witness.json");
  const command = `
    const fs = require("node:fs");
    const assert = require("node:assert/strict");
    const mapping = ${JSON.stringify(mapping)};
    const originals = ${JSON.stringify(originals)};
    const verify = () => {
      for (const [original, saved] of Object.entries(mapping)) {
        assert.deepEqual(fs.readFileSync(original), Buffer.from(originals[original], "base64"));
        assert.deepEqual(fs.readFileSync(saved.path), Buffer.from(originals[original], "base64"));
        assert.equal(fs.statSync(saved.path).mode & 0o222, 0);
      }
    };
    verify();
    const binding = {nonce:process.env.QRCLIP_WORK_CHECK_NONCE,
      id:process.env.QRCLIP_AGENT_WORK_ID,attempt:process.env.QRCLIP_WORK_CHECK_ATTEMPT};
    const reportPath = ${JSON.stringify(freshEvidence.reportPath)};
    const manifestPath = ${JSON.stringify(manifestPath)};
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    report.workCheck = binding;
    manifest.workCheck = binding;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => fs.writeFileSync(manifestPath, JSON.stringify(manifest)),
      error => ["EROFS","EACCES","EPERM"].includes(error.code));
    const freshManifestPath = ${JSON.stringify(freshEvidence.manifestPath)};
    const freshManifest = JSON.parse(fs.readFileSync(freshManifestPath, "utf8"));
    freshManifest.workCheck = binding;
    fs.writeFileSync(freshManifestPath, JSON.stringify(freshManifest));
    verify();
    fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify({before:true,after:true,denied:true}));
  `;
  const rejected = await f.tracker.check(first, next.attempt, {
    command: process.execPath, args: ["-e", command],
    firstCase: { report: freshEvidence.report, manifest: path.relative(cwd, freshEvidence.manifestPath),
      visualEvidence: freshEvidence.visualEvidence },
  });
  assert.equal(rejected.passed, false);
  assert.equal(rejected.firstCase, undefined);
  assert.deepEqual(JSON.parse(await readFile(witness, "utf8")), { before: true, after: true, denied: true });
  assert.equal(JSON.parse(await readFile(path.join(cwd, rejected.receipt.path), "utf8")).commands[0].code, 0);
  for (const file of historicPaths) {
    assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(originals[file], "base64"));
    assert.deepEqual(await readFile(path.join(cwd, mapping[file].path)), Buffer.from(originals[file], "base64"));
  }
  await assert.rejects(f.tracker.accept(first, next.attempt, { review: firstCaseReview }), { code: "unverified" });

  const secondEvidence = await firstCaseEvidence(f, { visual: true, prefix: "second-" });
  assert.equal((await acceptFirstCase(f, first, next.attempt, secondEvidence)).passed, true);
  await f.tracker.accept(first, next.attempt, { review: firstCaseReview });
  const secondAccepted = await f.tracker.issue(first);
  await writeFile(f.input, "stale source for a second historic generation");
  await f.tracker.recover(first, { operation: "refresh-first-case",
    assignee: secondAccepted.assignee, status: "closed", confirmedStopped: true,
    reason: "Append a second archive without replacing any previous bytes or mappings." });
  const generations = (await f.tracker.issue(first)).metadata.qrclipWork.artifactArchives;
  assert.equal(generations.length, 2);
  assert.deepEqual(generations[0], refreshed.metadata.qrclipWork.artifactArchives[0]);
  const firstPng = mapping[evidence.visualEvidence[0]];
  const secondPng = generations[1].artifacts[secondEvidence.visualEvidence[0]];
  assert.equal(firstPng.sha256, secondPng.sha256);
  assert.notEqual(firstPng.path, secondPng.path);
  for (const file of historicPaths)
    assert.deepEqual(await readFile(path.join(cwd, mapping[file].path)), Buffer.from(originals[file], "base64"));
});

test("damaged historical archive refuses the next command before any execution", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const accepted = await f.tracker.issue(first);
  await writeFile(f.input, "stale source before retained-byte rejection");
  await f.tracker.recover(first, { operation: "refresh-first-case",
    assignee: accepted.assignee, status: "closed", confirmedStopped: true,
    reason: "Keep the next command behind verified historic bytes." });
  const next = await f.tracker.prepare(first, { mode: "direct" });
  const archive = (await f.tracker.issue(first)).metadata.qrclipWork.artifactArchives[0];
  const retained = path.join(cwd, archive.artifacts[evidence.report].path);
  const original = await readFile(retained);
  const marker = path.join(path.dirname(f.input), "must-not-execute.txt");
  try {
    await chmod(retained, 0o600);
    await writeFile(retained, "deliberately damaged disposable retained bytes");
    await chmod(retained, 0o400);
    await assert.rejects(f.tracker.check(first, next.attempt, {
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`],
      firstCase: { report: path.relative(cwd, path.join(path.dirname(f.input), "new-report.json")),
        manifest: path.relative(cwd, path.join(path.dirname(f.input), "new-manifest.json")), visualEvidence: [] },
    }), { code: "artifact-preservation" });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const after = await f.tracker.issue(first);
    assert.equal(after.status, "in_progress");
    assert.equal(after.assignee, "omo:" + next.attempt);
    assert.equal(after.metadata.qrclipWork.checked, null);
  } finally {
    await chmod(retained, 0o600);
    await writeFile(retained, original);
    await chmod(retained, 0o400);
  }
});

test("read-only commands and cleanup preserve original evidence and archive paths", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const result = await f.tracker.check(scenario.id, scenario.attempt, {
    command: process.execPath, args: ["-e", immutableProbeCode(scenario, "primary")],
    firstCase: { report: scenario.fresh.report, manifest: path.relative(cwd, scenario.fresh.manifestPath),
      visualEvidence: scenario.fresh.visualEvidence },
    cleanup: { command: process.execPath, args: ["-e", immutableProbeCode(scenario, "cleanup")] },
  });
  assert.equal(result.passed, true);
  for (const role of ["primary", "cleanup"]) {
    const witness = JSON.parse(await readFile(path.join(path.dirname(scenario.fresh.reportPath),
      role + "-protection.json"), "utf8"));
    assert.deepEqual(witness, { denied: scenario.files.length * 9, fresh: true });
  }
  for (const file of scenario.files) {
    assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(scenario.bytes[file], "base64"));
    assert.equal((await lstat(path.join(cwd, file))).mode & 0o777, scenario.modes[file]);
  }
});

test("protected checks require explicit fresh report manifest and visual destinations", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const marker = path.join(path.dirname(scenario.fresh.reportPath), "invalid-destination-must-not-run");
  const valid = { report: scenario.fresh.report, manifest: path.relative(cwd, scenario.fresh.manifestPath),
    visualEvidence: scenario.fresh.visualEvidence };
  const before = await f.tracker.issue(scenario.id);
  for (const [name, descriptor] of [
    ["missing manifest", { ...valid, manifest: undefined }],
    ["old report", { ...valid, report: scenario.old.report }],
    ["old manifest", { ...valid, manifest: path.relative(cwd, scenario.old.manifestPath) }],
    ["old visual", { ...valid, visualEvidence: scenario.old.visualEvidence }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(f.tracker.check(scenario.id, scenario.attempt, {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`],
        firstCase: descriptor,
      }), { code: "fixture-evidence" });
      const after = await f.tracker.issue(scenario.id);
      assert.equal(after.status, before.status);
      assert.equal(after.assignee, before.assignee);
      assert.deepEqual(after.metadata, before.metadata);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    });
  }
});

test("real observation contexts discover stage6-shaped first-case manifests without guessed paths", async t => {
  for (const protectedCase of [false, true]) {
    await t.test(protectedCase ? "protected fresh directory" : "ordinary legacy descriptor", async st => {
      const f = await fixture(st);
      const scenario = protectedCase ? await refreshedProtectedCase(f) : undefined;
      const id = scenario?.id ?? await f.create([], { fixture: { stage: "first-case", visual: true } });
      const attempt = scenario?.attempt ?? (await f.tracker.prepare(id, { mode: "direct" })).attempt;
      const evidence = scenario?.fresh ?? await firstCaseEvidence(f, { visual: true });
      const observationDirectory = path.join(path.dirname(evidence.reportPath), "observation");
      await mkdir(observationDirectory);
      const proof = await f.tracker.check(id, attempt, {
        command: process.execPath,
        args: ["-e", `(async()=>{${scenario ? `{${immutableProbeCode(scenario, "primary")}}` : ""}
          ${observationFirstCaseCode(evidence, observationDirectory)}})().catch(e=>{console.error(e);process.exitCode=1})`],
        firstCase: { report: evidence.report, visualEvidence: evidence.visualEvidence,
          ...(protectedCase ? { observationDirectory: path.relative(cwd, observationDirectory) } : {}) },
        ...(scenario ? { cleanup: { command: process.execPath,
          args: ["-e", immutableProbeCode(scenario, "cleanup")] } } : {}),
      });
      assert.equal(proof.passed, true, `First check receipt: ${proof.receipt.path}\n${
        proof.passed ? "" : await readFile(path.join(cwd, proof.receipt.path), "utf8")}`);
      const report = JSON.parse(await readFile(evidence.reportPath, "utf8"));
      assert.equal(proof.firstCase.manifest, path.relative(cwd, report.observation.manifestPath));
      assert.ok(proof.firstCase.manifest.startsWith(path.relative(cwd, observationDirectory) + path.sep));
      assert.match(path.basename(path.dirname(report.observation.manifestPath)),
        /^qrclip-observation-[a-f0-9-]+-[a-zA-Z0-9]{6}$/);
      await f.tracker.accept(id, attempt, { review: firstCaseReview });
      if (scenario) {
        for (const role of ["primary", "cleanup"]) {
          const witness = JSON.parse(await readFile(path.join(path.dirname(evidence.reportPath),
            role + "-protection.json"), "utf8"));
          assert.equal(witness.denied, scenario.files.length * 9);
        }
        for (const file of scenario.files) {
          assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(scenario.bytes[file], "base64"));
          assert.equal((await lstat(path.join(cwd, file))).mode & 0o777, scenario.modes[file]);
        }
      }
    });
  }
});

test("discovered observations reject old outside symlink and hardlink manifests after cleanup", async t => {
  for (const attack of ["old manifest", "outside manifest", "cleanup old manifest", "symlink", "hardlink"]) {
    await t.test(attack, async st => {
      const f = await fixture(st);
      const scenario = await refreshedProtectedCase(f);
      const observationDirectory = path.join(path.dirname(scenario.fresh.reportPath), "observation");
      await mkdir(observationDirectory);
      const reportedManifest = attack === "old manifest" ? scenario.old.manifestPath :
        attack === "outside manifest" ? scenario.fresh.manifestPath : undefined;
      const proof = await f.tracker.check(scenario.id, scenario.attempt, {
        command: process.execPath,
        args: ["-e", `(async()=>{${observationFirstCaseCode(scenario.fresh, observationDirectory,
          { reportedManifest, copyManifest: attack === "outside manifest",
            alias: ["symlink", "hardlink"].includes(attack) ? attack : undefined })}})()
          .catch(e=>{console.error(e);process.exitCode=1})`],
        firstCase: { report: scenario.fresh.report, visualEvidence: scenario.fresh.visualEvidence,
          observationDirectory: path.relative(cwd, observationDirectory) },
        cleanup: { command: process.execPath, args: ["-e", `{${immutableProbeCode(scenario, "cleanup")}}
          ${attack === "cleanup old manifest" ? `
            const fs = require("node:fs");
            const reportPath = ${JSON.stringify(scenario.fresh.reportPath)};
            const report = JSON.parse(fs.readFileSync(reportPath,"utf8"));
            report.observation.manifestPath = ${JSON.stringify(scenario.old.manifestPath)};
            fs.writeFileSync(reportPath,JSON.stringify(report));
          ` : ""}`] },
      });
      assert.equal(proof.passed, false);
      const receipt = JSON.parse(await readFile(path.join(cwd, proof.receipt.path), "utf8"));
      assert.equal(receipt.commands[0].code, 0);
      const report = JSON.parse(await readFile(scenario.fresh.reportPath, "utf8"));
      assert.equal(report.observation.ok, true);
      assert.equal(report.observation.publicationComplete, true);
      assert.ok(receipt.failures.primary.some(failure =>
        failure.code === (attack === "symlink" ? "scope" : "fixture-evidence")));
      const witness = JSON.parse(await readFile(path.join(path.dirname(scenario.fresh.reportPath),
        "cleanup-protection.json"), "utf8"));
      assert.equal(witness.denied, scenario.files.length * 9);
      await assert.rejects(f.tracker.accept(scenario.id, scenario.attempt, { review: firstCaseReview }),
        { code: "unverified" });
      for (const file of scenario.files)
        assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(scenario.bytes[file], "base64"));
    });
  }
});

test("declared observation directories must be empty disjoint real output trees before execution", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const freshDirectory = path.dirname(scenario.fresh.reportPath);
  const observationDirectory = path.join(freshDirectory, "observation");
  const linkedDirectory = path.join(freshDirectory, "linked-observation");
  const nonempty = path.join(freshDirectory, "nonempty");
  await mkdir(observationDirectory);
  await symlink(observationDirectory, linkedDirectory);
  await mkdir(nonempty);
  await writeFile(path.join(nonempty, "prior-evidence"), "preserve");
  const marker = path.join(freshDirectory, "must-not-execute");
  for (const [name, directory, code] of [
    ["historical parent", path.dirname(scenario.old.manifestPath), "fixture-evidence"],
    ["nonempty output", nonempty, "fixture-evidence"],
    ["symlink directory", linkedDirectory, "scope"],
    ["symlink ancestor", path.join(linkedDirectory, "nested"), "scope"],
    ["checkout escape", path.join(cwd, "..", "observation"), "scope"],
  ]) {
    await t.test(name, async () => {
      const before = await f.tracker.issue(scenario.id);
      await assert.rejects(f.tracker.check(scenario.id, scenario.attempt, {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`],
        firstCase: { report: scenario.fresh.report, visualEvidence: scenario.fresh.visualEvidence,
          observationDirectory: path.relative(cwd, directory) },
        cleanup: { command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad cleanup")`] },
      }), { code });
      const after = await f.tracker.issue(scenario.id);
      assert.equal(after.status, before.status);
      assert.equal(after.assignee, before.assignee);
      assert.deepEqual(after.metadata, before.metadata);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    });
  }
});

test("first-case setup exposes its failed check receipt before acceptance", async t => {
  const f = await fixture(t);
  const id = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const prepared = await f.tracker.prepare(id, { mode: "direct" });
  const evidence = await firstCaseEvidence(f, { report: { passed: false } });
  await assert.rejects(acceptFirstCase(f, id, prepared.attempt, evidence), error => {
    assert.equal(error.code, "ERR_ASSERTION");
    assert.match(error.message, /First check receipt: \.beads\/checks\/.*\/manifest\.json/);
    assert.match(error.message, /"code"\s*:\s*"fixture-evidence"/);
    return true;
  });
  const value = await f.tracker.issue(id);
  assert.equal(value.status, "in_progress");
  assert.equal(value.metadata.qrclipWork.checked.passed, false);
  assert.equal(value.metadata.qrclipWork.accepted, undefined);
});

test("fixture edit parked across accept and refresh cannot erase protected metadata", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const gate = await gatedTracker(t, f, "first-update");
  const pending = gate.tracker.edit(first, { fixture: { stage: "first-case", visual: true } })
    .then(value => ({ value }), error => ({ error }));
  try {
    await gate.reached;
    const attempt = await f.tracker.prepare(first, { mode: "direct" });
    await acceptFirstCase(f, first, attempt.attempt, await firstCaseEvidence(f));
    await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
    const accepted = await f.tracker.issue(first);
    await writeFile(f.input, "stale source across the pending fixture edit");
    await f.tracker.recover(first, { operation: "refresh-first-case", assignee: accepted.assignee,
      status: "closed", confirmedStopped: true, reason: "Exercise the real edit acceptance/refresh ABA." });
    const refreshed = await f.tracker.issue(first);
    await gate.release();
    assert.equal((await pending).error?.code, "stale-input");
    const after = await f.tracker.issue(first);
    assert.equal(after.status, "open");
    assert.ok(after.assignee == null || after.assignee === "");
    assert.deepEqual(after.metadata, refreshed.metadata);
  } finally {
    await gate.release();
    await pending;
  }
});

test("interrupted refresh cannot lose accepted proof through generic recovery", async t => {
  for (const mode of ["refresh-before-comment", "refresh-after-comment", "committed-refresh-comment"]) {
    await t.test(mode, async st => {
      const f = await fixture(st);
      const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
      const attempt = await f.tracker.prepare(first, { mode: "direct" });
      const evidence = await firstCaseEvidence(f);
      await acceptFirstCase(f, first, attempt.attempt, evidence);
      await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
      const accepted = await f.tracker.issue(first);
      const proof = accepted.metadata.qrclipWork.accepted;
      const files = [...Object.keys(proof.firstCase.artifacts), proof.receipt.path];
      const originals = await Promise.all(files.map(file => readFile(path.join(cwd, file))));
      await writeFile(f.input, "stale source before injected refresh interruption");
      const gate = await gatedTracker(st, f, mode);
      const pending = gate.tracker.recover(first, { operation: "refresh-first-case",
        assignee: accepted.assignee, status: "closed", confirmedStopped: true,
        reason: "Exercise a stopped in-flight refresh without losing its accepted generation." })
        .then(value => ({ value }), error => ({ error }));
      try {
        await gate.reached;
        const reserved = await f.tracker.issue(first);
        await assert.rejects(f.tracker.recover(first, { assignee: reserved.assignee, status: reserved.status,
          reason: "Generic recovery must not discard an interrupted accepted generation.",
          confirmedStopped: true }), { code: "recovery" });
        assert.deepEqual((await f.tracker.issue(first)).metadata, reserved.metadata);
        await gate.release();
        assert.equal((await pending).error?.code, 1);
        const interrupted = await f.tracker.issue(first);
        assert.equal(interrupted.status, "blocked");
        assert.equal(interrupted.metadata.qrclipWork.refresh.version, 1);
        assert.deepEqual(interrupted.metadata.qrclipWork.accepted, proof);
        for (let index = 0; index < files.length; index++)
          assert.deepEqual(await readFile(path.join(cwd, files[index])), originals[index]);
        const resumed = await f.tracker.recover(first, { operation: "refresh-first-case",
          assignee: interrupted.assignee, status: "blocked", confirmedStopped: true,
          reason: "Resume only after reconciling retained bytes and the durable archive comment." });
        assert.equal(resumed.status, "open");
        const finished = await f.tracker.issue(first);
        assert.equal(finished.metadata.qrclipWork.refresh, undefined);
        assert.equal(finished.metadata.qrclipWork.accepted, undefined);
        assert.equal(finished.metadata.qrclipWork.artifactArchives.length, 1);
        const history = JSON.parse((await exec("bd", ["--sandbox", "comments", first, "--json"],
          { cwd, env: { ...process.env, GIT_MASTER: "1" }, timeout: 10000 })).stdout);
        assert.equal(history.map(comment => JSON.parse(comment.text)).filter(comment =>
          comment.kind === "recovery" && comment.operation === "refresh-first-case").length, 1);
        for (let index = 0; index < files.length; index++)
          assert.deepEqual(await readFile(path.join(cwd, files[index])), originals[index]);
      } finally {
        await gate.release();
        await pending;
      }
    });
  }
});

test("unavailable filesystem protection refuses primary and cleanup with the first cause retained", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const bin = path.join(path.dirname(f.input), "unavailable-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "bwrap"), "#!/bin/sh\nprintf 'fixture isolation unavailable\\n' >&2\nexit 125\n", { mode: 0o700 });
  const primary = path.join(path.dirname(scenario.fresh.reportPath), "primary-must-not-run");
  const cleanup = path.join(path.dirname(scenario.fresh.reportPath), "cleanup-must-not-run");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin + path.delimiter + originalPath;
    await assert.rejects(f.tracker.check(scenario.id, scenario.attempt, {
      command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(primary)}, "bad")`],
      firstCase: { report: scenario.fresh.report, manifest: path.relative(cwd, scenario.fresh.manifestPath),
        visualEvidence: scenario.fresh.visualEvidence },
      cleanup: { command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(cleanup)}, "bad")`] },
    }), error => error.code === "artifact-protection-unavailable" &&
      error.cause?.code === 125 && error.cause.stderr.includes("fixture isolation unavailable"));
  } finally { process.env.PATH = originalPath; }
  await assert.rejects(readFile(primary), { code: "ENOENT" });
  await assert.rejects(readFile(cleanup), { code: "ENOENT" });
  for (const file of scenario.files)
    assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(scenario.bytes[file], "base64"));
  const after = await f.tracker.issue(scenario.id);
  assert.equal(after.status, "in_progress");
  assert.equal(after.metadata.qrclipWork.checked, null);
});

test("protected cleanup cannot hide the primary failure or alter original receipt bytes", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const result = await f.tracker.check(scenario.id, scenario.attempt, {
    command: process.execPath, args: ["-e", "process.exit(7)"],
    firstCase: { report: scenario.fresh.report, manifest: path.relative(cwd, scenario.fresh.manifestPath),
      visualEvidence: scenario.fresh.visualEvidence },
    cleanup: { command: process.execPath, args: ["-e", immutableProbeCode(scenario, "cleanup")] },
  });
  assert.equal(result.passed, false);
  const receipt = JSON.parse(await readFile(path.join(cwd, result.receipt.path), "utf8"));
  assert.equal(receipt.commands[0].label, "work-check");
  assert.equal(receipt.commands[0].code, 7);
  assert.equal(receipt.commands[1].label, "work-cleanup");
  assert.equal(receipt.commands[1].code, 0);
  for (const file of scenario.files)
    assert.deepEqual(await readFile(path.join(cwd, file)), Buffer.from(scenario.bytes[file], "base64"));
});

test("fresh writable trees cannot contain hard-link aliases of original evidence", async t => {
  const f = await fixture(t);
  const scenario = await refreshedProtectedCase(f);
  const alias = path.join(path.dirname(scenario.fresh.reportPath), "old-evidence-alias");
  const marker = path.join(path.dirname(scenario.fresh.reportPath), "alias-command-must-not-run");
  await link(path.join(cwd, scenario.old.report), alias);
  try {
    await assert.rejects(f.tracker.check(scenario.id, scenario.attempt, {
      command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`],
      firstCase: { report: scenario.fresh.report, manifest: path.relative(cwd, scenario.fresh.manifestPath),
        visualEvidence: scenario.fresh.visualEvidence },
    }), { code: "fixture-evidence" });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await rm(alias); }
  assert.deepEqual(await readFile(path.join(cwd, scenario.old.report)),
    Buffer.from(scenario.bytes[scenario.old.report], "base64"));
});

test("partial refresh resumes safely and fixture cleanup removes only its own archive directories", async t => {
  const f = await fixture(t);
  const first = await f.create([], { fixture: { stage: "first-case", visual: false } });
  const attempt = await f.tracker.prepare(first, { mode: "direct" });
  const evidence = await firstCaseEvidence(f);
  await acceptFirstCase(f, first, attempt.attempt, evidence);
  await f.tracker.accept(first, attempt.attempt, { review: firstCaseReview });
  const accepted = await f.tracker.issue(first);
  const proof = accepted.metadata.qrclipWork.accepted;
  const receiptBytes = await readFile(path.join(cwd, proof.receipt.path));
  await writeFile(f.input, "stale source before a partial archive fault");
  const gate = await gatedTracker(t, f, "refresh-copy");
  const pending = gate.tracker.recover(first, { operation: "refresh-first-case",
    assignee: accepted.assignee, status: "closed", confirmedStopped: true,
    reason: "Inject a collision only into a newly owned partial archive." })
    .then(value => ({ value }), error => ({ error }));
  let partial;
  try {
    await gate.reached;
    const candidate = JSON.parse(await readFile(gate.ready, "utf8")).qrclipWork.refresh;
    partial = path.join(cwd, candidate.directory);
    const expected = { ...proof.firstCase.artifacts, [proof.receipt.path]: proof.receipt.sha256 };
    const firstHash = expected[Object.keys(expected).sort((a, b) => a.localeCompare(b))[0]];
    await writeFile(path.join(partial, firstHash), "owned collision fixture");
    await gate.release();
    assert.equal((await pending).error?.code, "artifact-preservation");
    const stopped = await f.tracker.issue(first);
    assert.deepEqual(stopped.metadata.qrclipWork.accepted, proof);
    await assert.rejects(f.tracker.recover(first, { assignee: stopped.assignee, status: "blocked",
      reason: "Do not erase this partial refresh.", confirmedStopped: true }), { code: "recovery" });
    await f.tracker.recover(first, { operation: "refresh-first-case", assignee: stopped.assignee,
      status: "blocked", confirmedStopped: true, reason: "Resume into a new archive without replacing partial backing." });
    const completed = (await f.tracker.issue(first)).metadata.qrclipWork.artifactArchives[0];
    const completeFile = path.join(cwd, completed.artifacts[evidence.report].path);
    assert.notEqual(path.dirname(completeFile), partial);
    const other = await fixture(t);
    const otherId = await other.create();
    const foreign = await mkdtemp(path.join(cwd, ".beads", "retired-artifacts", otherId + "-"));
    const foreignFile = path.join(foreign, "a".repeat(64));
    await writeFile(foreignFile, "another fixture owns this evidence");
    await removeFixtureArchives([first]);
    await assert.rejects(lstat(partial), { code: "ENOENT" });
    await assert.rejects(readFile(completeFile), { code: "ENOENT" });
    assert.equal(await readFile(foreignFile, "utf8"), "another fixture owns this evidence");
    assert.deepEqual(await readFile(path.join(cwd, proof.receipt.path)), receiptBytes);
  } finally {
    await gate.release();
    await pending;
  }
});
