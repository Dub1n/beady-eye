import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link, realpath } from "node:fs/promises";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkTracker } from "../agent-work.mjs";
import { runWorkCommand } from "../agent-work-cli.mjs";

const onWsl = process.platform === "linux" && /microsoft|wsl/i.test(`${os.release()} ${os.version()}`);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const reason = "Run this trusted disposable fixture without OS filesystem isolation.";
const producer = `
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRunContext } from "./observer.mjs";
const mode = process.argv[2];
await writeFile("reached.txt", "primary");
if (mode !== "missing-report") {
  const run = await createRunContext({
    output: "fresh/observations", scenario: "synthetic-first-case",
    budgetMs: 3000, primaryMs: 1800, cleanupMs: 900, publicationMs: 300,
  });
  run.setPrimary({ passed: true });
  const terminal = await run.finalize({ cleanupVerified: true });
  const files = {};
  for (const file of ["source.txt", "producer.mjs", "observer.mjs"])
    files[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  const report = {
    passed: terminal.ok, cleanup: [{ passed: true }], publicationErrors: [],
    workCheck: run.workCheck, source: { files },
    observation: { ok: terminal.ok, manifestPath: terminal.manifestPath },
  };
  if (mode === "wrong-nonce") report.workCheck = { ...report.workCheck, nonce: "unrelated" };
  if (mode === "stale-source") report.source.files["source.txt"] = "0".repeat(64);
  if (mode === "failed-cleanup") report.cleanup[0].passed = false;
  if (mode === "failed-manifest") {
    const manifest = JSON.parse(await readFile(terminal.manifestPath, "utf8"));
    manifest.primary.ok = false;
    await writeFile(terminal.manifestPath, JSON.stringify(manifest));
  }
  await writeFile("fresh/report.json", JSON.stringify(report));
}
`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beads-wsl-exception-"));
  t.after(() => rm(directory, { recursive: true }));
  const state = path.join(directory, "state.json");
  const binary = path.join(directory, "bd-fixture.mjs");
  // Reuse the existing disposable show/update/CAS store. Preparation's packet
  // also reads comments; this fresh store has no comments.
  await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("comments")) process.stdout.write("[]");
else await import(${JSON.stringify(new URL("./agent-work-test-bd.mjs", import.meta.url).href)});
`, { mode: 0o700 });
  await writeFile(binary + ".json", JSON.stringify({ mode: "disposable-store", state }));
  await writeFile(path.join(directory, "source.txt"), "owned source");
  await writeFile(path.join(directory, "prerequisite.txt"), "accepted prerequisite source");
  await writeFile(path.join(directory, "producer.mjs"), producer);
  await writeFile(path.join(directory, "observer.mjs"),
    await readFile(new URL("../harness-observation.mjs", import.meta.url)));
  await mkdir(path.join(directory, "fresh", "observations"), { recursive: true });
  const original = "original.txt";
  const originalBytes = "accepted disposable receipt";
  const digest = sha256(originalBytes);
  const saved = path.join(".beads", "retired-artifacts", "fixture", digest);
  await mkdir(path.dirname(path.join(directory, saved)), { recursive: true });
  await writeFile(path.join(directory, original), originalBytes);
  await writeFile(path.join(directory, saved), originalBytes, { mode: 0o444 });
  await writeFile(state, JSON.stringify({
    fixture: {
      id: "fixture", status: "open", assignee: "",
      dependencies: [{ id: "prerequisite", dependency_type: "blocks" }],
      metadata: { qrclipWork: {
        version: 1, paths: ["source.txt", "producer.mjs", "observer.mjs"],
        fixture: { stage: "first-case", visual: false }, retiredArtifacts: [original],
        artifactArchives: [{ receipt: { path: original, sha256: digest },
          artifacts: { [original]: { path: saved, sha256: digest } } }],
      } },
    },
    prerequisite: {
      id: "prerequisite", status: "closed", metadata: { qrclipWork: {
        version: 1, paths: ["prerequisite.txt"], accepted: {
          paths: ["prerequisite.txt"],
          sources: { "prerequisite.txt": sha256("accepted prerequisite source") },
          receipt: { path: original, sha256: digest },
        },
      } },
    },
  }));
  const trackerFor = (actor, options = {}) => createWorkTracker({ cwd: directory, actor, binary, ...options });
  const tracker = trackerFor("fixture-coordinator");
  const prepared = await tracker.prepare("fixture", { mode: "direct" });
  const waiver = { id: "fixture", attempt: prepared.attempt, reason };
  const options = {
    command: process.execPath, args: ["producer.mjs", "valid"], kind: "functional", budgetMs: 10000,
    cleanup: { command: process.execPath,
      args: ["-e", 'require("node:fs").appendFileSync("reached.txt", " cleanup")'] },
    firstCase: { report: "fresh/report.json", observationDirectory: "fresh/observations", visualEvidence: [] },
    wslFixtureException: waiver,
  };
  return {
    directory, state, tracker, trackerFor, attempt: prepared.attempt, waiver, options, original, saved,
    async mutate(change) {
      const stored = JSON.parse(await readFile(state, "utf8"));
      change(stored.fixture);
      await writeFile(state, JSON.stringify(stored));
    },
    async check(overrides = {}, caller = tracker) {
      return runWorkCommand(caller, "check", { id: "fixture", attempt: prepared.attempt,
        ...options, ...overrides });
    },
  };
}

test("a project opt-in verifies retained aggregate evidence on WSL without running commands",
  { skip: !onWsl, timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await f.mutate(item => { delete item.metadata.qrclipWork.fixture; });
    const manifest = '{"status":"complete"}';
    await writeFile(path.join(f.directory, "build.json"), manifest);
    await writeFile(path.join(f.directory, "build.bin"), "a retained build");
    const input = {
      id: "fixture", attempt: f.attempt, kind: "functional", budgetMs: 10_000,
      retainedEvidence: [
        { path: "build.json", sha256: sha256(manifest), completeManifest: true },
        { path: "build.bin", sha256: sha256("a retained build") },
      ],
    };
    const enabled = f.trackerFor("fixture-coordinator", { allowWslEvidenceChecks: true });
    const command = process.execPath;
    const args = ["-e", 'require("node:fs").writeFileSync("aggregate-command-ran", "unexpected")'];
    const before = await readFile(f.state);
    await assert.rejects(runWorkCommand(f.tracker, "check", input), { code: "artifact-protection-unavailable" });
    for (const extra of [{ command, args }, { cleanup: { command, args } }, { outputDirectories: ["fresh"] }])
      await assert.rejects(runWorkCommand(enabled, "check", { ...input, ...extra }), { code: "retained-evidence" });
    await assert.rejects(runWorkCommand(enabled, "check", {
      id: input.id, attempt: input.attempt, command, args,
    }), { code: "artifact-protection-unavailable" });
    assert.deepEqual(await readFile(f.state), before);
    await assert.rejects(readFile(path.join(f.directory, "aggregate-command-ran")), { code: "ENOENT" });

    const proof = await runWorkCommand(enabled, "check", input);
    assert.equal(proof.passed, true, JSON.stringify(proof));
    assert.deepEqual(proof.retainedEvidence, input.retainedEvidence);
    assert.equal(proof.sources["build.bin"], sha256("a retained build"));
    assert.ok(proof.paths.includes("build.bin"));
    const receipt = JSON.parse(await readFile(path.join(f.directory, proof.receipt.path)));
    assert.equal(receipt.primary.kind, "retained-evidence");
    assert.deepEqual(receipt.commands, []);
    assert.equal(await readFile(path.join(f.directory, f.original), "utf8"), "accepted disposable receipt");

    await writeFile(path.join(f.directory, "build.bin"), "replaced build");
    await assert.rejects(enabled.accept(input.id, input.attempt), { code: "unverified" });
    await writeFile(path.join(f.directory, "build.bin"), "a retained build");
    assert.deepEqual(await enabled.accept(input.id, input.attempt), { id: "fixture", accepted: true });
  });

test("the updated writer carries large retained evidence through downstream acceptance",
  { skip: process.platform !== "linux", timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await f.mutate(item => { delete item.metadata.qrclipWork.fixture; });
    const artifact = path.join(f.directory, "large.bin");
    const bytes = Buffer.alloc(17 * 1024 * 1024, 4);
    await writeFile(artifact, bytes);
    const enabled = f.trackerFor("fixture-coordinator", { allowWslEvidenceChecks: true });
    const input = { kind: "functional", budgetMs: 10_000 };
    const retainedEvidence = [{ path: "large.bin", sha256: sha256(bytes) }];
    assert.equal((await enabled.check("fixture", f.attempt, { ...input, retainedEvidence })).passed, true);
    await enabled.accept("fixture", f.attempt);
    const downstream = async (id, blockedBy, evidenceFile) => {
      const state = JSON.parse(await readFile(f.state, "utf8"));
      state[id] = {
        id, status: "open", assignee: "", dependencies: [{ id: blockedBy, dependency_type: "blocks" }],
        metadata: { qrclipWork: { version: 1, paths: ["source.txt"] } },
      };
      await writeFile(f.state, JSON.stringify(state));
      await writeFile(path.join(f.directory, evidenceFile), id);
      return enabled.prepare(id, { mode: "direct" });
    };
    const { attempt } = await downstream("middle", "fixture", "middle.bin");
    const checked = await enabled.check("middle", attempt, {
      ...input, retainedEvidence: [{ path: "middle.bin", sha256: sha256("middle") }],
    });
    assert.equal(checked.passed, true);
    assert.deepEqual(checked.inheritedRetainedEvidence, retainedEvidence);
    await enabled.accept("middle", attempt);
    await writeFile(artifact, "changed ancestor");
    await assert.rejects(downstream("last", "middle", "last.bin"), { code: "blocked" });
  });

test("retained evidence cannot pass with mismatched, aliased, or incomplete files",
  { skip: process.platform !== "linux", timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await f.mutate(item => { delete item.metadata.qrclipWork.fixture; });
    const manifest = '{"status":"failed"}';
    const file = path.join(f.directory, "build.json");
    await writeFile(file, manifest);
    await symlink(file, path.join(f.directory, "symlink.json"));
    await link(file, path.join(f.directory, "hardlink.json"));
    const enabled = f.trackerFor("fixture-coordinator", { allowWslEvidenceChecks: true });
    const request = { id: "fixture", attempt: f.attempt, kind: "functional", budgetMs: 5000 };
    const entry = { path: "build.json", sha256: sha256(manifest) };
    for (const path of ["symlink.json", "hardlink.json"]) {
      const result = await runWorkCommand(enabled, "check", { ...request,
        retainedEvidence: [{ ...entry, path }] });
      assert.equal(result.passed, false, path);
    }
    await rm(path.join(f.directory, "hardlink.json"));
    for (const evidence of [{ ...entry, sha256: "0".repeat(64) }, { ...entry, completeManifest: true }]) {
      const result = await runWorkCommand(enabled, "check", { ...request, retainedEvidence: [evidence] });
      assert.equal(result.passed, false);
    }
  });

test("WSL fixture exception rejects invalid scope and actors before reservation",
  { skip: !onWsl, timeout: 20000 }, async t => {
    const f = await fixture(t);
    const cases = [
      { name: "null", waiver: null },
      { name: "array", waiver: [] },
      { name: "wrong id", waiver: { ...f.waiver, id: "other" } },
      { name: "wrong attempt", waiver: { ...f.waiver, attempt: "unrelated" } },
      { name: "missing reason", waiver: { id: "fixture", attempt: f.attempt } },
      { name: "blank reason", waiver: { ...f.waiver, reason: " ".repeat(20) } },
      { name: "short reason", waiver: { ...f.waiver, reason: "yes" } },
      { name: "nonstring reason", waiver: { ...f.waiver, reason: 123 } },
      { name: "oversize reason", waiver: { ...f.waiver, reason: "a".repeat(4001) } },
      { name: "unknown field", waiver: { ...f.waiver, enabled: true } },
      { name: "other actor", waiver: f.waiver, caller: f.trackerFor("other-session") },
    ];
    for (const item of cases) {
      const before = await readFile(f.state);
      await assert.rejects(f.check({ wslFixtureException: item.waiver }, item.caller),
        { code: "wsl-fixture-exception" }, item.name);
      assert.deepEqual(await readFile(f.state), before, item.name);
    }
    const beforeMissingEvidence = await readFile(f.state);
    await assert.rejects(f.check({ firstCase: undefined }), { code: "fixture-evidence" });
    assert.deepEqual(await readFile(f.state), beforeMissingEvidence);
    for (const contract of [undefined, { stage: "first-case", visual: true },
      { stage: "expansion", firstCase: "other" }]) {
      await f.mutate(issue => { issue.metadata.qrclipWork.fixture = contract; });
      const before = await readFile(f.state);
      await assert.rejects(f.check(), { code: "wsl-fixture-exception" });
      assert.deepEqual(await readFile(f.state), before);
    }
    await assert.rejects(readFile(path.join(f.directory, "reached.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
  });

test("ordinary protected first-case checks remain blocked without a trusted grant",
  { skip: !onWsl, timeout: 10000 }, async t => {
    const f = await fixture(t);
    const before = await readFile(f.state);
    await assert.rejects(f.check({ wslFixtureException: undefined }),
      { code: "artifact-protection-unavailable" });
    assert.deepEqual(await readFile(f.state), before);
    await assert.rejects(readFile(path.join(f.directory, "reached.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
  });

test("WSL fixture exception rejects irrelevant non-WSL kernel identity",
  { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const before = await readFile(f.state);
    const release = os.release;
    const version = os.version;
    try {
      os.release = () => "6.1.0";
      os.version = () => "Linux";
      syncBuiltinESMExports();
      await assert.rejects(f.check(), { code: "wsl-fixture-exception" });
    } finally {
      os.release = release;
      os.version = version;
      syncBuiltinESMExports();
    }
    assert.deepEqual(await readFile(f.state), before);
    await assert.rejects(readFile(path.join(f.directory, "reached.txt")), { code: "ENOENT" });
  });

test("WSL fixture exception executes primary and cleanup with durable scoped receipt",
  { skip: !onWsl, timeout: 15000 }, async t => {
    const f = await fixture(t);
    assert.equal(f.tracker.limits().wslFixtureExceptionVersion, 1);
    const proof = await f.check();
    assert.equal(proof.passed, true, `Receipt: ${proof.receipt.path}`);
    // This marker is outside the declared writable output trees. Its writes
    // prove both commands ran directly, without a nested read-only bwrap view.
    assert.equal(await readFile(path.join(f.directory, "reached.txt"), "utf8"), "primary cleanup");
    const expected = { ...f.waiver, coordinator: "fixture-coordinator" };
    assert.equal(proof.filesystemIsolation, false);
    assert.deepEqual(proof.wslFixtureException, expected);
    const stored = JSON.parse(await readFile(f.state, "utf8")).fixture;
    assert.deepEqual(stored.metadata.qrclipWork.checked, proof);
    assert.equal(stored.status, "in_progress");
    assert.equal(stored.assignee, `omo:${f.attempt}`);
    const receiptBytes = await readFile(path.join(f.directory, proof.receipt.path));
    assert.equal(sha256(receiptBytes), proof.receipt.sha256);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.filesystemIsolation, false);
    assert.deepEqual(receipt.wslFixtureException, expected);
    assert.equal(receipt.status, "complete");
    assert.deepEqual(receipt.commands.map(command => command.code), [0, 0]);
    const observation = JSON.parse(await readFile(path.join(f.directory,
      path.dirname(proof.receipt.path), "manifest.json"), "utf8"));
    assert.deepEqual(observation.events.find(event => event.name === "filesystem-isolation").details,
      { filesystemIsolation: false, receipt: "wsl-fixture-receipt.json" });
    assert.equal(proof.cleanup, "command-verified");
    assert.equal(proof.sources["source.txt"], sha256("owned source"));
    assert.equal(proof.sources["prerequisite.txt"], sha256("accepted prerequisite source"));
    assert.equal(proof.prerequisites.prerequisite, sha256("accepted disposable receipt"));
    const report = JSON.parse(await readFile(path.join(f.directory, proof.firstCase.report), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(f.directory, proof.firstCase.manifest), "utf8"));
    assert.equal(report.workCheck.id, "fixture");
    assert.equal(report.workCheck.attempt, f.attempt);
    assert.match(report.workCheck.nonce, /^[a-f0-9-]{36}$/);
    assert.deepEqual(manifest.workCheck, report.workCheck);
    for (const file of [f.original, f.saved])
      assert.equal(await readFile(path.join(f.directory, file), "utf8"), "accepted disposable receipt");
    await assert.rejects(f.trackerFor("other-session").accept("fixture", f.attempt,
      { review: "Not the preparing coordinator." }), { code: "ownership" });
  });

test("WSL fixture exception still requires valid fresh first-case evidence",
  { skip: !onWsl, timeout: 20000 }, async t => {
    for (const mode of ["missing-report", "wrong-nonce", "stale-source", "failed-cleanup", "failed-manifest"]) {
      await t.test(mode, async t => {
        const f = await fixture(t);
        const proof = await f.check({ args: ["producer.mjs", mode] });
        assert.equal(proof.passed, false);
        assert.equal(proof.firstCase, undefined);
        assert.equal(await readFile(path.join(f.directory, "reached.txt"), "utf8"), "primary cleanup");
        const receipt = JSON.parse(await readFile(path.join(f.directory, proof.receipt.path), "utf8"));
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.filesystemIsolation, false);
        assert.deepEqual(receipt.wslFixtureException, { ...f.waiver, coordinator: "fixture-coordinator" });
        await assert.rejects(f.tracker.accept("fixture", f.attempt,
          { review: "Evidence must pass before acceptance." }), { code: "unverified" });
      });
    }
  });

test("WSL fixture exception preserves freshness and historical artifact validation",
  { skip: !onWsl, timeout: 15000 }, async t => {
    for (const { file, rejection } of [
      { file: "source.txt", rejection: "unverified" },
      { file: "prerequisite.txt", rejection: "blocked" },
      { file: "original.txt", rejection: "blocked" },
    ]) {
      await t.test(file, async t => {
        const f = await fixture(t);
        const proof = await f.check({ cleanup: { command: process.execPath, args: ["-e",
          `const fs = require("node:fs"); fs.appendFileSync("reached.txt", " cleanup"); fs.writeFileSync(${JSON.stringify(file)}, "changed");`,
        ] } });
        assert.equal(proof.passed, false);
        assert.equal(await readFile(path.join(f.directory, "reached.txt"), "utf8"), "primary cleanup");
        const stored = JSON.parse(await readFile(f.state, "utf8")).fixture.metadata.qrclipWork.checked;
        assert.equal(stored.passed, false);
        await assert.rejects(f.tracker.accept("fixture", f.attempt,
          { review: "Changed inputs cannot be accepted." }), { code: rejection });
      });
    }
  });

test("trusted fixture executes pinned actions and detects historical evidence changes",
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const primary = path.join(f.directory, "trusted-primary.mjs");
    const cleanup = path.join(f.directory, "trusted-cleanup.mjs");
    const verifier = path.join(f.directory, "trusted-verifier.mjs");
    await writeFile(primary, `
      import { writeFile } from "node:fs/promises";
      await writeFile("report.json", JSON.stringify({
        passed: false, cleanup: [], publicationErrors: [],
        workCheck: { nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
          id: process.env.QRCLIP_AGENT_WORK_ID, attempt: process.env.QRCLIP_WORK_CHECK_ATTEMPT },
      }));
      await writeFile("primary.marker", "ran");
    `);
    await writeFile(cleanup, `
      import { appendFile, unlink } from "node:fs/promises";
      await unlink(${JSON.stringify(path.join(f.directory, f.original))});
      await unlink(${JSON.stringify(path.join(f.directory, f.saved))});
      await appendFile("cleanup.marker", "ran");
      process.exitCode = 4;
    `);
    await writeFile(verifier, `
      import { readFile, writeFile } from "node:fs/promises";
      await readFile("cleanup.marker");
      await writeFile("verifier.marker", "ran");
    `);
    const executable = await realpath(process.execPath);
    const executableBytes = await readFile(executable);
    const descriptor = {
      version: 1, executable, sha256: sha256(executableBytes),
      args: [primary],
      cleanup: { executable, sha256: sha256(executableBytes), args: [cleanup] },
      verifyCleanup: { executable, sha256: sha256(executableBytes), args: [verifier] },
      env: { PATH: process.env.PATH || "", TRUSTED_MARKER: "invented" },
      projectInputs: [],
    };
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-operator-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const descriptorPath = path.join(operatorDirectory, "trusted-fixture.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const grant = {
      "invented-fixture": { descriptor: descriptorPath, sha256: sha256(await readFile(descriptorPath)) },
    };
    const granted = f.trackerFor("fixture-coordinator", { trustedFixtures: grant });
    assert.equal(granted.limits().trustedFixtureCheckVersion, 1);
    const proof = await runWorkCommand(granted, "check", {
      id: "fixture", attempt: f.attempt, kind: "functional", budgetMs: 15000,
      trustedFixture: "invented-fixture",
    });
    assert.equal(proof.filesystemIsolation, false);
    assert.equal(proof.detectionOnly, true);
    assert.equal(proof.passed, false);
    assert.equal(proof.cleanup, "verification-failed");
    assert.ok(proof.trustedFixture.violations.some(item => item.path === f.original));
    assert.ok(proof.trustedFixture.violations.some(item => item.path === f.saved));
    assert.equal(await readFile(path.join(f.directory, proof.trustedFixture.outputDirectory,
      "primary.marker"), "utf8"), "ran");
    assert.equal(await readFile(path.join(f.directory, proof.trustedFixture.outputDirectory,
      "cleanup.marker"), "utf8"), "ran");
    assert.equal(await readFile(path.join(f.directory, proof.trustedFixture.outputDirectory,
      "verifier.marker"), "utf8"), "ran");
    const stored = JSON.parse(await readFile(f.state, "utf8")).fixture;
    assert.equal(stored.metadata.qrclipWork.checked.passed, false);
    const receipt = JSON.parse(await readFile(path.join(f.directory, proof.receipt.path), "utf8"));
    assert.equal(receipt.filesystemIsolation, false);
    assert.equal(receipt.detectionOnly, true);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.passed, false);
    assert.equal(receipt.trustedFixture.verifier, "passed");
    assert.equal(receipt.trustedFixture.actions.primary.sha256, sha256(executableBytes));
    assert.notEqual(receipt.trustedFixture.actions.cleanup.status, "not-run");
    assert.notEqual(receipt.trustedFixture.actions.verifier.status, "not-run");
    if (process.env.BDI_TEST_FIRST_CASE_EVIDENCE_DIR) {
      const bytes = await readFile(path.join(f.directory, proof.receipt.path));
      assert.equal(sha256(bytes), proof.receipt.sha256);
      await writeFile(path.join(process.env.BDI_TEST_FIRST_CASE_EVIDENCE_DIR,
        `damage-control-${proof.receipt.sha256}.json`), bytes, { flag: "wx", mode: 0o600 });
    }
  });

test("trusted fixture evidence seals reject missing and mutable manifests before reservation",
  { timeout: 20000 }, async t => {
    for (const manifestState of ["missing", "mutable"]) {
      await t.test(manifestState, async t => {
        const f = await fixture(t);
        const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-seal-"));
        t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
        const manifest = path.join(operatorDirectory, "evidence-manifest.json");
        if (manifestState === "mutable") await writeFile(manifest, '{"version":1,"files":{}}\n');
        const marker = path.join(operatorDirectory, "action-ran");
        const executable = await realpath(process.execPath);
        const executableSha256 = sha256(await readFile(executable));
        const action = { executable, sha256: executableSha256,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] };
        const descriptor = {
          version: 1, ...action,
          cleanup: action, verifyCleanup: action,
          env: { PATH: process.env.PATH || "" }, projectInputs: [],
          evidenceSeal: { manifest },
        };
        const descriptorPath = path.join(operatorDirectory, "trusted-fixture.json");
        await writeFile(descriptorPath, JSON.stringify(descriptor));
        const granted = f.trackerFor("fixture-coordinator", { trustedFixtures: {
          "sealed-fixture": { descriptor: descriptorPath,
            sha256: sha256(await readFile(descriptorPath)) },
        } });
        assert.equal(granted.limits().evidenceSealVersion, 1);
        const before = await readFile(f.state);

        await assert.rejects(granted.check("fixture", f.attempt, {
          trustedFixture: "sealed-fixture", kind: "functional", budgetMs: 10000,
        }), error => ["trusted-fixture", "trusted-fixture-seal"].includes(error.code));

        assert.deepEqual(await readFile(f.state), before, "Invalid seals must not reserve or mutate the work item.");
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        await assert.rejects(readdir(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
        assert.deepEqual((await readdir(f.directory)).filter(name =>
          name.startsWith(".trusted-fixture-run-")), [], "Invalid seals must not create fixture output phases.");
      });
    }
  });

test("trusted fixture project input pins alone do not satisfy sealed evidence coverage",
  { timeout: 20000 }, async t => {
    const f = await fixture(t);
    await f.mutate(item => {
      item.dependencies = [];
      delete item.metadata.qrclipWork.fixture;
      delete item.metadata.qrclipWork.retiredArtifacts;
      delete item.metadata.qrclipWork.artifactArchives;
    });
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-seal-input-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const manifest = path.join(operatorDirectory, "evidence-manifest.json");
    await writeFile(manifest, '{"version":1,"files":{}}\n');
    const marker = path.join(operatorDirectory, "action-ran");
    const executable = await realpath(process.execPath);
    const executableSha256 = sha256(await readFile(executable));
    const action = { executable, sha256: executableSha256,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] };
    const descriptor = {
      version: 1, ...action,
      cleanup: action, verifyCleanup: action,
      env: { PATH: process.env.PATH || "" },
      projectInputs: [{ path: "producer.mjs", sha256: sha256(await readFile(path.join(f.directory, "producer.mjs"))) }],
      evidenceSeal: { manifest },
    };
    const descriptorPath = path.join(operatorDirectory, "trusted-fixture.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const granted = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "input-only": { descriptor: descriptorPath, sha256: sha256(await readFile(descriptorPath)) },
    } });
    const before = await readFile(f.state);

    await assert.rejects(granted.check("fixture", f.attempt, {
      trustedFixture: "input-only", kind: "functional", budgetMs: 10000,
    }), { code: "trusted-fixture-seal" });

    assert.deepEqual(await readFile(f.state), before);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readdir(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
    assert.deepEqual((await readdir(f.directory)).filter(name =>
      name.startsWith(".trusted-fixture-run-")), []);
  });

test("external evidence archives use accepted Beads coverage before reservation",
  { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-external-seal-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const archiveRoot = path.join(operatorDirectory, "archive");
    await mkdir(archiveRoot);
    const manifest = path.join(operatorDirectory, "evidence-manifest.json");
    await writeFile(manifest, JSON.stringify({
      version: 1, project: archiveRoot, files: {},
    }));
    const marker = path.join(operatorDirectory, "action-ran");
    const executable = await realpath(process.execPath);
    const executableSha256 = sha256(await readFile(executable));
    const action = { executable, sha256: executableSha256,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] };
    const descriptor = {
      version: 1, ...action,
      cleanup: action, verifyCleanup: action,
      env: { PATH: process.env.PATH || "" },
      // A pinned checkout input must not enlarge the external expected set.
      projectInputs: [{ path: "producer.mjs",
        sha256: sha256(await readFile(path.join(f.directory, "producer.mjs"))) }],
      evidenceSeal: { manifest, archiveRoot },
    };
    const descriptorPath = path.join(operatorDirectory, "trusted-fixture.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const granted = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "external-seal": { descriptor: descriptorPath,
        sha256: sha256(await readFile(descriptorPath)) },
    } });
    assert.equal(granted.limits().externalEvidenceArchiveVersion, 1);
    const before = await readFile(f.state);

    await assert.rejects(granted.check("fixture", f.attempt, {
      trustedFixture: "external-seal", kind: "functional", budgetMs: 10000,
    }), { code: "trusted-fixture-seal" });

    assert.deepEqual(await readFile(f.state), before,
      "External archive mismatch must fail before reserving the work item.");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readdir(path.join(f.directory, ".beads", "checks")), { code: "ENOENT" });
    assert.deepEqual((await readdir(f.directory)).filter(name =>
      name.startsWith(".trusted-fixture-run-")), []);
  });

test("trusted fixture rejects caller actions, missing grants, and expansions before reservation",
  { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const granted = f.trackerFor("fixture-coordinator", { trustedFixtures: {} });
    for (const extra of [
      { command: process.execPath, args: ["-e", ""] },
      { cleanup: { command: process.execPath, args: ["-e", ""] } },
      { expectedExitCodes: [0, 1] },
      { env: { TRUSTED_MARKER: "caller-override" } },
      { outputDirectories: ["caller-output"] },
      { firstCase: { report: "caller-report.json", visualEvidence: [] } },
    ]) {
      const before = await readFile(f.state);
      await assert.rejects(granted.check("fixture", f.attempt, {
        trustedFixture: "invented-fixture", kind: "functional", budgetMs: 5000, ...extra,
      }), { code: "trusted-fixture" });
      assert.deepEqual(await readFile(f.state), before);
    }
    const before = await readFile(f.state);
    await assert.rejects(f.tracker.check("fixture", f.attempt, {
      trustedFixture: "invented-fixture", kind: "functional", budgetMs: 5000,
    }), { code: "trusted-fixture" });
    assert.deepEqual(await readFile(f.state), before);
    await f.mutate(item => { item.metadata.qrclipWork.fixture = { stage: "expansion", firstCase: "prerequisite" }; });
    await assert.rejects(granted.check("fixture", f.attempt, {
      trustedFixture: "invented-fixture", kind: "functional", budgetMs: 5000,
    }), { code: "trusted-fixture" });
  });

test("trusted fixture detects cleanup executable replacement after primary",
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const primary = path.join(f.directory, "mutate-cleanup-pin.mjs");
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-operator-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const cleanup = path.join(operatorDirectory, "cleanup-tool");
    await writeFile(cleanup, "#!/bin/sh\nprintf ran > cleanup.marker\n", { mode: 0o700 });
    await writeFile(primary, `
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(cleanup)}, "#!/bin/sh\\nprintf changed > cleanup.marker\\n");
      await writeFile("primary.marker", "ran");
    `);
    const executable = await realpath(process.execPath);
    const executableBytes = await readFile(executable);
    const descriptor = {
      version: 1, executable, sha256: sha256(executableBytes), args: [primary],
      cleanup: { executable: cleanup, sha256: sha256(await readFile(cleanup)), args: [] },
      verifyCleanup: { executable, sha256: sha256(executableBytes),
        args: ["-e", 'require("node:fs").writeFileSync("verifier.marker", "ran")'] },
      env: { PATH: process.env.PATH || "", TRUSTED_MARKER: "pinned" },
      projectInputs: [{ path: "mutate-cleanup-pin.mjs", sha256: sha256(await readFile(primary)) }],
    };
    const descriptorPath = path.join(operatorDirectory, "pin-mutation.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const tracker = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "pin-mutation": { descriptor: descriptorPath, sha256: sha256(await readFile(descriptorPath)) },
    } });
    const proof = await tracker.check("fixture", f.attempt, {
      trustedFixture: "pin-mutation", kind: "functional", budgetMs: 15000,
    });
    assert.equal(proof.passed, false);
    assert.equal(proof.cleanup, "verification-failed");
    assert.ok(proof.trustedFixture.violations.some(item => item.path === "trusted-project-inputs"));
    const output = path.join(f.directory, proof.trustedFixture.outputDirectory);
    assert.equal(await readFile(path.join(output, "primary.marker"), "utf8"), "ran");
    await assert.rejects(readFile(path.join(output, "cleanup.marker")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(output, "verifier.marker")), { code: "ENOENT" });
    const receipt = JSON.parse(await readFile(path.join(f.directory, proof.receipt.path), "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.trustedFixture.actions.primary.status, "exit");
    assert.equal(receipt.trustedFixture.actions.cleanup.status, "not-run");
    assert.equal(receipt.trustedFixture.actions.verifier.status, "not-run");
  });

test("trusted fixture rejects descriptors stored inside the checked-out project",
  { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const descriptorPath = path.join(f.directory, "in-project-fixture.json");
    await writeFile(descriptorPath, "{}");
    const tracker = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "inside-project": { descriptor: descriptorPath, sha256: "0".repeat(64) },
    } });
    const before = await readFile(f.state);
    await assert.rejects(tracker.check("fixture", f.attempt, {
      trustedFixture: "inside-project", kind: "functional", budgetMs: 5000,
    }), error => error.code === "trusted-fixture" &&
      /outside the project/.test(error.message));
    assert.deepEqual(await readFile(f.state), before);
    await assert.rejects(readFile(path.join(f.directory, "reached.txt")), { code: "ENOENT" });
  });

test("trusted fixture runs on ordinary direct work with an accepted blocker",
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.ordinary = {
      id: "ordinary", status: "open", assignee: "",
      dependencies: [{ id: "prerequisite", dependency_type: "blocks" }],
      metadata: { qrclipWork: { version: 1, paths: ["source.txt"] } },
    };
    await writeFile(f.state, JSON.stringify(state));
    const prepared = await f.tracker.prepare("ordinary", { mode: "direct" });
    const fixtureInput = Buffer.alloc(17 * 1024 * 1024, 0x35);
    await writeFile(path.join(f.directory, "fixture-input.apk"), fixtureInput);
    const script = path.join(f.directory, "ordinary-fixture.mjs");
    await writeFile(script, `
      import { writeFile } from "node:fs/promises";
      await writeFile("primary-phase.json", JSON.stringify({
        cwd: process.cwd(), marker: process.env.TRUSTED_MARKER,
        nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
      }));
    `);
    const executable = await realpath(process.execPath);
    const executableBytes = await readFile(executable);
    const descriptor = {
      version: 1, executable, sha256: sha256(executableBytes), args: [script],
      cleanup: { executable, sha256: sha256(executableBytes), args: ["-e", `
        require("node:fs").writeFileSync("cleanup-phase.json", JSON.stringify({
          cwd: process.cwd(), marker: process.env.TRUSTED_MARKER,
          nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
        }));
      `] },
      verifyCleanup: { executable, sha256: sha256(executableBytes), args: ["-e", `
        require("node:fs").writeFileSync("verifier-phase.json", JSON.stringify({
          cwd: process.cwd(), marker: process.env.TRUSTED_MARKER,
          nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
        }));
      `] },
      env: { PATH: process.env.PATH || "", TRUSTED_MARKER: "from-grant" },
      projectInputs: [
        { path: "source.txt", sha256: sha256("owned source") },
        { path: "fixture-input.apk", sha256: sha256(fixtureInput) },
      ],
    };
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-operator-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const descriptorPath = path.join(operatorDirectory, "ordinary-fixture.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const tracker = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "ordinary-case": { descriptor: descriptorPath, sha256: sha256(await readFile(descriptorPath)) },
    } });
    const proof = await tracker.check("ordinary", prepared.attempt, {
      trustedFixture: "ordinary-case", kind: "functional", budgetMs: 15000,
    });
    assert.equal(proof.passed, true, JSON.stringify(proof));
    assert.equal(proof.firstCase, undefined);
    assert.equal(proof.filesystemIsolation, false);
    assert.equal(proof.detectionOnly, true);
    const runDirectory = path.join(f.directory, proof.trustedFixture.outputDirectory);
    const phases = await Promise.all(["primary", "cleanup", "verifier"].map(async phase =>
      JSON.parse(await readFile(path.join(runDirectory, `${phase}-phase.json`)))));
    assert.ok(phases.every(phase => phase.cwd === runDirectory));
    assert.ok(phases.every(phase => phase.marker === "from-grant"));
    assert.ok(phases.every(phase => phase.nonce === phases[0].nonce));
    const checked = JSON.parse(await readFile(f.state, "utf8")).ordinary;
    assert.equal(checked.status, "in_progress");
    assert.equal(checked.metadata.qrclipWork.fixture, undefined);
    assert.equal(checked.metadata.qrclipWork.accepted, undefined);
  });

test("trusted fixture records declared first-case evidence and still requires review",
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.mutate(item => { item.metadata.qrclipWork.fixture.visual = true; });
    const script = path.join(f.directory, "trusted-first-case.mjs");
    const observer = pathToFileURL(path.join(f.directory, "observer.mjs")).href;
    await writeFile(script, `
      import { readFile, writeFile } from "node:fs/promises";
      import { createHash } from "node:crypto";
      import path from "node:path";
      import { createRunContext } from ${JSON.stringify(observer)};
      const run = await createRunContext({
        output: process.env.QRCLIP_HARNESS_OUTPUT, scenario: "invented-trusted-first-case",
        budgetMs: 4000, primaryMs: 2200, cleanupMs: 1200, publicationMs: 300,
      });
      run.setPrimary({ passed: true });
      const terminal = await run.finalize({ cleanupVerified: true });
      const files = {};
      for (const file of ["source.txt", "producer.mjs", "observer.mjs"])
        files[file] = createHash("sha256").update(await readFile(path.join(${JSON.stringify(f.directory)}, file))).digest("hex");
      await writeFile("report.json", JSON.stringify({
        passed: terminal.ok, cleanup: [{ passed: true }], publicationErrors: [],
        workCheck: run.workCheck, source: { files },
        observation: { ok: terminal.ok, manifestPath: terminal.manifestPath },
      }));
      await writeFile("captured.png", Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==",
        "base64"));
    `);
    const executable = await realpath(process.execPath);
    const executableBytes = await readFile(executable);
    const descriptor = {
      version: 1, executable, sha256: sha256(executableBytes), args: [script],
      cleanup: { executable, sha256: sha256(executableBytes), args: ["-e", ""] },
      verifyCleanup: { executable, sha256: sha256(executableBytes), args: ["-e", ""] },
      env: { PATH: process.env.PATH || "", TRUSTED_MARKER: "first-case" },
      projectInputs: [{ path: "trusted-first-case.mjs",
        sha256: sha256(await readFile(script)) }],
    };
    const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "beads-fixture-operator-"));
    t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
    const descriptorPath = path.join(operatorDirectory, "first-case.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const tracker = f.trackerFor("fixture-coordinator", { trustedFixtures: {
      "declared-first-case": { descriptor: descriptorPath, sha256: sha256(await readFile(descriptorPath)) },
    } });
    const proof = await tracker.check("fixture", f.attempt, {
      trustedFixture: "declared-first-case", kind: "functional", budgetMs: 20000,
    });
    assert.equal(proof.passed, true, JSON.stringify(proof));
    assert.ok(proof.firstCase);
    assert.equal(proof.firstCase.visualEvidence.length, 1);
    const checked = JSON.parse(await readFile(f.state, "utf8")).fixture;
    assert.equal(checked.status, "in_progress");
    assert.equal(checked.metadata.qrclipWork.accepted, undefined);
    await assert.rejects(tracker.accept("fixture", f.attempt), { code: "fixture-review" });
    assert.deepEqual(await tracker.accept("fixture", f.attempt, {
      review: "Inspected the invented trusted first-case report and manifest.",
    }), { id: "fixture", accepted: true });
    if (process.env.BDI_TEST_FIRST_CASE_EVIDENCE_DIR) {
      const destination = await mkdtemp(path.join(process.env.BDI_TEST_FIRST_CASE_EVIDENCE_DIR, "first-case-"));
      for (const [file, expected] of Object.entries({
        ...proof.firstCase.artifacts, [proof.receipt.path]: proof.receipt.sha256,
      })) {
        const bytes = await readFile(path.join(f.directory, file));
        assert.equal(sha256(bytes), expected);
        await writeFile(path.join(destination, path.basename(file)), bytes, { flag: "wx", mode: 0o600 });
      }
      await writeFile(path.join(destination, "proof.json"), JSON.stringify(proof), { flag: "wx", mode: 0o600 });
    }
  });
