import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { actor, attempt, execute, host, launch, primary, secondary, sandbox } from "./host.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../../packages/beads-work/cli.mjs", import.meta.url));
const fixtureId = "invented-cleanup-fixture";
const windowsFixtureId = "invented-windows-cleanup-fixture";
const windowsPowerShell51 = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const windowsPowerShell7 = "/mnt/c/Program Files/PowerShell/7/pwsh.exe";
const inputText = "invented fixture input only\n";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function fileSha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function descriptorFor(project, executableSha256) {
  const input = join(project.cwd, "fixture-input.txt");
  await writeFile(input, inputText);

  const primary = [
    "const fs = require('node:fs');",
    "const input = fs.readFileSync(process.env.FIXTURE_INPUT, 'utf8');",
    "if (input !== " + JSON.stringify(inputText) + ") process.exit(11);",
    "fs.writeFileSync('fixture-output.txt', 'invented output only\\n');",
  ].join("");
  const cleanup = "require('node:fs').rmSync('fixture-output.txt', { force: true });";
  const verifyCleanup = [
    "if (require('node:fs').existsSync('fixture-output.txt')) process.exit(12);",
    "process.stdout.write('invented cleanup verified\\n');",
  ].join("");
  const descriptor = {
    version: 1,
    executable: process.execPath,
    sha256: executableSha256,
    args: ["-e", primary],
    projectInputs: [{ path: "fixture-input.txt", sha256: sha256(Buffer.from(inputText)) }],
    cleanup: { executable: process.execPath, sha256: executableSha256, args: ["-e", cleanup] },
    verifyCleanup: {
      executable: process.execPath, sha256: executableSha256, args: ["-e", verifyCleanup],
    },
    env: { FIXTURE_INPUT: input },
  };

  const externalFixtures = join(dirname(project.cwd), "external-fixtures");
  await mkdir(externalFixtures, { recursive: true });
  const descriptorPath = join(externalFixtures, `${basename(project.cwd)}-${fixtureId}.json`);
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(descriptorPath, bytes);
  return { descriptorPath, descriptorSha256: sha256(bytes) };
}

async function windowsDescriptorFor(project, evidenceSeal) {
  let executable;
  let notice;
  try {
    await access(windowsPowerShell51);
    const powershell51 = await realpath(windowsPowerShell51);
    const info = await stat(powershell51, { bigint: true });
    if (info.nlink === 1n) executable = powershell51;
    else notice = `Windows PowerShell 5.1 has nlink=${info.nlink}; using pinable PowerShell 7.`;
  } catch (error) {
    notice = `${windowsPowerShell51} is unavailable (${error.code || error.name})`;
  }
  if (!executable) {
    try {
      await access(windowsPowerShell7);
      executable = await realpath(windowsPowerShell7);
    } catch (error) {
      return { unavailable: `${notice}; ${windowsPowerShell7} is unavailable (${error.code || error.name})` };
    }
  }
  const info = await stat(executable, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o111n) === 0n)
    return { unavailable: `${executable} is not a single-link executable file (nlink=${info.nlink}).` };
  const executableSha256 = await fileSha256(executable);
  const outputDirectory = join(dirname(project.cwd), `${basename(project.cwd)}-windows-output`);
  await mkdir(outputDirectory);
  const { stdout } = await exec("/usr/bin/wslpath", ["-w", outputDirectory]);
  const windowsDirectory = stdout.trim().replaceAll("'", "''");
  const location = `Set-Location -LiteralPath '${windowsDirectory}'; `;
  const outputFile = `'${windowsDirectory}\\fixture-output.txt'`;
  const descriptor = {
    version: 1,
    executable,
    sha256: executableSha256,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; " + location +
        `[IO.File]::WriteAllText(${outputFile}, 'invented Windows fixture text only')`],
    projectInputs: [],
    cleanup: { executable, sha256: executableSha256, args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; " + location +
        `if (-not (Test-Path -LiteralPath ${outputFile})) { exit 14 }; Remove-Item -LiteralPath ${outputFile} -Force`,
    ] },
    verifyCleanup: { executable, sha256: executableSha256, args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; " + location +
        `if (Test-Path -LiteralPath ${outputFile}) { exit 13 }; Write-Output 'invented cleanup verified'`,
    ] },
    env: {},
    ...(evidenceSeal && { evidenceSeal }),
  };
  const externalFixtures = join(dirname(project.cwd), "external-fixtures");
  await mkdir(externalFixtures, { recursive: true });
  const descriptorPath = join(externalFixtures, `${basename(project.cwd)}-${windowsFixtureId}.json`);
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(descriptorPath, bytes);
  return {
    descriptorPath,
    descriptorSha256: sha256(bytes),
    executable,
    executableSha256,
    outputDirectory,
    notice,
  };
}

async function cliCheck(project, input) {
  try {
    return await exec(process.execPath, [cli, "check", JSON.stringify(input)], {
      cwd: project.cwd,
      env: cliEnvironment(project),
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const details = JSON.stringify({
      issue: await project.issue(),
      calls: await project.calls(),
    });
    error.message += `\nSynthetic tracker state at failure: ${details}`;
    throw error;
  }
}

function cliEnvironment(project) {
  return {
    ...process.env,
    BDI_WORK_POLICY: join(dirname(project.cwd), ".config", "beady-eye", "work-policy.json"),
    QRCLIP_AGENT_SESSION: actor,
  };
}

async function assertTrustedResult(project, result, grant, expectedFixtureId = fixtureId) {
  if (result.passed !== true) {
    let commands = [];
    try {
      const report = JSON.parse(await readFile(join(project.cwd, result.receipt.path)));
      commands = report.commands.map(command => Object.fromEntries(Object.entries(command)
        .filter(([key]) => ["label", "role", "outcome", "code", "exit", "close", "signal",
          "error", "stderr", "stdout", "expectedExitCodes"].includes(key))));
    } catch (error) {
      commands = [{ reportReadError: error.code || error.name }];
    }
    assert.fail("Trusted fixture check failed: " + JSON.stringify({
      result, commands, issue: await project.issue(), calls: await project.calls(),
    }));
  }
  assert.equal(result.kind, "functional");
  assert.equal(result.filesystemIsolation, false);
  assert.equal(result.detectionOnly, true);
  assert.equal(result.trustedFixture.id, expectedFixtureId);
  assert.equal(result.trustedFixture.descriptorSha256, grant.descriptorSha256);
  assert.equal(result.trustedFixture.verifier, "passed");
  assert.deepEqual(result.trustedFixture.violations, []);

  const receiptBytes = await readFile(join(project.cwd, result.receipt.path));
  assert.equal(sha256(receiptBytes), result.receipt.sha256);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.detectionOnly, true);
  assert.equal(receipt.filesystemIsolation, false);
  assert.deepEqual(receipt.trustedFixture, result.trustedFixture);
  return { fixture: receipt.trustedFixture, bytes: receiptBytes,
    path: join(project.cwd, result.receipt.path) };
}

async function preserveReceiptSummary(handoffPath, items) {
  await mkdir(dirname(handoffPath), { recursive: true });
  const receipts = [];
  for (const item of items) {
    const preservedPath = `${handoffPath}.${item.entryPoint}.receipt.json`;
    await writeFile(preservedPath, item.evidence.bytes, { flag: "wx" });
    receipts.push({
      entryPoint: item.entryPoint,
      passed: item.result.passed,
      kind: item.result.kind,
      fixtureId: item.result.trustedFixture.id,
      descriptorSha256: item.grant.descriptorSha256,
      receipt: {
        sourcePath: item.evidence.path,
        sha256: item.result.receipt.sha256,
        preservedPath,
      },
    });
  }
  await writeFile(handoffPath, JSON.stringify({
    example: "invented trusted fixture integration",
    receipts,
  }, null, 2) + "\n", { flag: "wx" });
}

function checkInput() {
  return { id: primary, attempt, kind: "functional", trustedFixture: fixtureId, budgetMs: 20000 };
}

test("a writable checkout checks accepted Beads hashes against a separate immutable archive", {
  timeout: 45000,
  skip: !process.env.BDI_TEST_ADMIN_SEAL_ROOT && "requires the read-only dummy archive from docs/evidence-seal-test.md",
}, async t => {
  const adminRoot = process.env.BDI_TEST_ADMIN_SEAL_ROOT;
  assert.match(adminRoot, /^\/var\/lib\/beady-eye-seal-test\.[a-z0-9]{8}$/i);
  const archiveRoot = join(adminRoot, "project");
  const manifest = join(adminRoot, "manifest.json");
  const file = "evidence/receipt.txt";
  const seed = "Invented sealed evidence only.\n";
  const s = await sandbox(t);
  const project = await s.project("writable-checkout");
  await project.prepare(primary, attempt, actor);
  const issue = await project.issue();
  issue.status = "in_progress";
  issue.metadata.qrclipWork.attempt.mode = "direct";
  issue.dependencies = [{ id: secondary, dependency_type: "blocks" }];
  await project.save(issue);
  await mkdir(join(project.cwd, "evidence"));
  // Change the checkout and its disposable tracker *together*. An implementation
  // that reads only the checkout would accept this negative control.
  async function accepted(bytes) {
    await writeFile(join(project.cwd, file), bytes);
    await project.save({ id: secondary, status: "closed", metadata: { qrclipWork: {
      version: 1, paths: [], accepted: { paths: [], sources: {},
        receipt: { path: file, sha256: sha256(bytes) } },
    } } });
  }
  const grant = await descriptorFor(project, await fileSha256(process.execPath));
  const descriptor = JSON.parse(await readFile(grant.descriptorPath, "utf8"));
  descriptor.evidenceSeal = { archiveRoot, manifest };
  const bytes = Buffer.from(JSON.stringify(descriptor));
  await writeFile(grant.descriptorPath, bytes);
  grant.descriptorSha256 = sha256(bytes);
  await s.policy([{ root: project.cwd, level: "management", trustedFixtures: {
    [fixtureId]: { descriptor: grant.descriptorPath, sha256: grant.descriptorSha256 },
  } }]);
  const h = host(), ctx = h.ctx(project.cwd);
  await launch(h, ctx);
  await accepted("Different accepted bytes in writable checkout.\n");
  await assert.rejects(execute(h, ctx, "check", checkInput()), { code: "trusted-fixture-seal" });
  assert.equal((await project.calls()).some(call => call.includes("update")), false);

  await accepted(seed);
  const checked = (await execute(h, ctx, "check", checkInput())).details;
  const evidence = await assertTrustedResult(project, checked, grant);
  const expectedSeal = { archiveRoot, manifest, version: 1,
    manifestSha256: await fileSha256(manifest), fileCount: 1 };
  assert.deepEqual(evidence.fixture.evidenceSeal, expectedSeal);
  const freshRow = await project.issue();
  assert.deepEqual(freshRow.metadata.qrclipWork.checked.trustedFixture, checked.trustedFixture);
  assert.equal(freshRow.metadata.qrclipWork.accepted, undefined);
  assert.equal(await readFile(join(archiveRoot, file), "utf8"), seed);
  const handoff = process.env.BDI_TRUSTED_FIXTURE_HANDOFF;
  if (handoff) await preserveReceiptSummary(`${handoff}.archive.json`,
    [{ entryPoint: "external-archive", result: checked, evidence, grant }]);
  const windows = await windowsDescriptorFor(project, { manifest, archiveRoot });
  if (windows.unavailable) {
    t.diagnostic(`External archive Windows control not exercised: ${windows.unavailable}`);
    return;
  }
  await s.policy([{ root: project.cwd, level: "management", trustedFixtures: {
    [windowsFixtureId]: { descriptor: windows.descriptorPath, sha256: windows.descriptorSha256 },
  } }]);
  const { stdout } = await cliCheck(project, { ...checkInput(), trustedFixture: windowsFixtureId });
  const windowsProof = JSON.parse(stdout);
  const windowsReceipt = await assertTrustedResult(project, windowsProof, windows, windowsFixtureId);
  assert.deepEqual(windowsReceipt.fixture.evidenceSeal, expectedSeal);
  assert.equal(await readFile(join(archiveRoot, file), "utf8"), seed);
  if (handoff) await preserveReceiptSummary(`${handoff}.archive.windows.json`,
    [{ entryPoint: "windows-external-archive", result: windowsProof, evidence: windowsReceipt, grant: windows }]);
});

test("trusted fixture checks use pinned project policy through CLI and OmO callback",
  { timeout: 30000 }, async t => {
    const s = await sandbox(t);
    const cliProject = await s.project("cli-fixture");
    const toolProject = await s.project("tool-fixture");
    await cliProject.prepare(primary, attempt, actor);
    await toolProject.prepare(primary, attempt, actor);
    for (const project of [cliProject, toolProject]) {
      const issue = await project.issue();
      issue.status = "in_progress";
      issue.metadata.qrclipWork.attempt.mode = "direct";
      await project.save(issue);
    }

    const executableSha256 = await fileSha256(process.execPath);
    const cliGrant = await descriptorFor(cliProject, executableSha256);
    const toolGrant = await descriptorFor(toolProject, executableSha256);
    const hostApp = host();
    const cliPolicy = { root: cliProject.cwd, level: "delegation" };
    const toolPolicy = { root: toolProject.cwd, level: "delegation" };
    const toolCtx = hostApp.ctx(toolProject.cwd, actor);
    await launch(hostApp, toolCtx);

    await s.policy([cliPolicy, toolPolicy]);
    await assert.rejects(cliCheck(cliProject, checkInput()), error => {
      assert.equal(JSON.parse(error.stderr).code, "trusted-fixture");
      return true;
    });
    await assert.rejects(execute(hostApp, toolCtx, "check", checkInput()), error => {
      assert.equal(error.code, "trusted-fixture");
      return true;
    });

    cliPolicy.trustedFixtures = {
      [fixtureId]: { descriptor: cliGrant.descriptorPath, sha256: cliGrant.descriptorSha256 },
    };
    await s.policy([cliPolicy, toolPolicy]);
    const { stdout: policyOutput } = await exec(process.execPath, [cli, "policy"], {
      cwd: cliProject.cwd, env: cliEnvironment(cliProject),
    });
    assert.deepEqual(JSON.parse(policyOutput).trustedFixtures, [fixtureId]);
    const cliIssue = await cliProject.issue();
    assert.equal(cliIssue.status, "in_progress");
    assert.equal(cliIssue.assignee, `omo:${attempt}`);
    assert.equal(cliIssue.metadata.qrclipWork.attempt.mode, "direct");
    assert.equal(cliIssue.metadata.qrclipWork.attempt.coordinator, actor);
    const { stdout } = await cliCheck(cliProject, checkInput());
    const cliResult = JSON.parse(stdout);
    const cliEvidence = await assertTrustedResult(cliProject, cliResult, cliGrant);
    assert.equal((await cliProject.issue()).metadata.qrclipWork.checked.trustedFixture.id,
      fixtureId);

    toolPolicy.trustedFixtures = {
      [fixtureId]: { descriptor: toolGrant.descriptorPath, sha256: toolGrant.descriptorSha256 },
    };
    await s.policy([cliPolicy, toolPolicy]);
    const toolResult = await execute(hostApp, toolCtx, "check", checkInput());
    const toolEvidence = await assertTrustedResult(toolProject, toolResult.details, toolGrant);
    assert.equal((await toolProject.issue()).metadata.qrclipWork.checked.trustedFixture.id,
      fixtureId);

    const handoffPath = process.env.BDI_TRUSTED_FIXTURE_HANDOFF;
    if (handoffPath) {
      await preserveReceiptSummary(handoffPath, [
        { entryPoint: "cli", result: cliResult, evidence: cliEvidence, grant: cliGrant },
        { entryPoint: "omo-tool", result: toolResult.details, evidence: toolEvidence, grant: toolGrant },
      ]);
      t.diagnostic(`Preserved CLI and OmO synthetic receipts at ${handoffPath}`);
    }

    const windowsGrant = await windowsDescriptorFor(cliProject);
    let windowsResult;
    let windowsEvidence;
    if (windowsGrant.unavailable) {
      t.diagnostic(`Native Windows fixture not exercised: ${windowsGrant.unavailable}`);
    } else {
      if (windowsGrant.notice) t.diagnostic(windowsGrant.notice);
      cliPolicy.trustedFixtures[windowsFixtureId] = {
        descriptor: windowsGrant.descriptorPath,
        sha256: windowsGrant.descriptorSha256,
      };
      await s.policy([cliPolicy, toolPolicy]);
      const { stdout: windowsStdout } = await cliCheck(cliProject, {
        ...checkInput(), trustedFixture: windowsFixtureId,
      });
      windowsResult = JSON.parse(windowsStdout);
      windowsEvidence = await assertTrustedResult(cliProject, windowsResult, windowsGrant, windowsFixtureId);
      try {
        await access(join(windowsGrant.outputDirectory, "fixture-output.txt"));
        assert.fail("native Windows fixture output survived cleanup");
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
      if (handoffPath) {
        const windowsSummaryPath = `${handoffPath}.windows.json`;
        await preserveReceiptSummary(windowsSummaryPath, [{
          entryPoint: "powershell-windows",
          result: windowsResult,
          evidence: windowsEvidence,
          grant: windowsGrant,
        }]);
        t.diagnostic(`Preserved native Windows synthetic receipt at ${windowsSummaryPath}`);
      }
    }

    for (const receipt of [
      cliEvidence.fixture,
      toolEvidence.fixture,
    ]) {
      try {
        await access(join(receipt.outputDirectory, "fixture-output.txt"));
        assert.fail("fixture output survived cleanup");
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
    }

    const cliCalls = await cliProject.calls();
    const toolCalls = await toolProject.calls();
    assert.ok(cliCalls.some(call => call.includes("update") && call.includes(primary)));
    assert.ok(toolCalls.some(call => call.includes("update") && call.includes(primary)));
  });
