import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorkTracker } from "../../../packages/beads-work/agent-work.mjs";
import { execute, host, launch, result, task } from "./host.mjs";

const exec = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("stopped-owner recovery fences delayed receipt writes and callbacks while a replacement earns acceptance",
  { timeout: 60_000 }, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "bdi-work-replacement-"));
    t.after(() => rm(root, { recursive: true }));
    const cwd = join(root, "harbor");
    const policyDir = join(root, ".config", "beady-eye");
    await mkdir(policyDir, { recursive: true });
    await mkdir(cwd);
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TMPDIR: root,
      PATH: process.env.PATH, USER: "fixture", GIT_MASTER: "1", BD_NO_HOOKS: "true",
      BD_DISABLE_METRICS: "1", BEADS_DOLT_AUTO_START: "false", BEADS_DOLT_SHARED_SERVER: "false" };
    await exec("git", ["init", "--quiet"], { cwd, env, timeout: 3000 });
    await exec("bd", ["--sandbox", "init", "--prefix", "smt", "--stealth",
      "--skip-agents", "--skip-hooks", "--non-interactive"], { cwd, env, timeout: 15_000 });
    await writeFile(join(policyDir, "work-policy.json"), JSON.stringify({
      version: 1, scope: "explicit-projects", defaultLevel: "disabled",
      projects: [{ root: cwd, level: "delegation" }],
    }));
    const previousEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      TMPDIR: process.env.TMPDIR };
    t.after(() => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    Object.assign(process.env, { HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, TMPDIR: env.TMPDIR });

    const oldParent = host(), newParent = host(), worker = host();
    const oldActor = "fixture-harbor-parent", newActor = "fixture-slipway-parent";
    const oldCtx = oldParent.ctx(cwd, oldActor), newCtx = newParent.ctx(cwd, newActor);
    const oldWorker = worker.ctx(cwd, "fixture-harbor-worker");
    const newWorker = worker.ctx(cwd, "fixture-slipway-worker");
    await launch(oldParent, oldCtx);
    await launch(newParent, newCtx);
    await launch(worker, oldWorker);
    const source = "rail.txt", original = "old rail\n", replacement = "new rail\n";
    const checkArgs = ["-e", "require('node:assert/strict').equal(" +
      "require('node:fs').readFileSync(process.argv[1], 'utf8'), process.argv[2])", source];
    await writeFile(join(cwd, source), original);
    const { details: { id } } = await execute(oldParent, oldCtx, "create", {
      title: "Refit the gallery rail", objective: "Verify the replacement rail",
      paths: [source],
    });
    const { details: old } = await execute(oldParent, oldCtx, "prepare", { id, mode: "delegate" });
    const admitted = task({ prompt: `${old.marker}\nInspect the rail.` }, "fixture-old-call");
    assert.equal(await oldParent.emit(admitted, oldCtx), undefined);
    const lateResult = result(admitted, { task_id: "st_old_rail", status: "completed" });
    const { details: oldCheck } = await execute(worker, oldWorker, "check", {
      id, attempt: old.attempt, kind: "functional", budgetMs: 5000,
      command: process.execPath, args: [...checkArgs, original],
    });
    assert.equal(oldCheck.passed, true);
    const oldReceiptPath = join(cwd, oldCheck.receipt.path);
    const oldReceipt = await readFile(oldReceiptPath);
    assert.equal(sha256(oldReceipt), oldCheck.receipt.sha256);
    worker.emit({ type: "session_shutdown" }, oldWorker);
    await assert.rejects(execute(worker, oldWorker, "show", { id }), { code: "session" });

    // Pause receipt delivery after the tracker reads the old attempt, before its
    // guarded write reaches Beads. There is no running worker behind this receipt.
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    const publishing = createWorkTracker({ cwd, actor: oldActor, env,
      async beforeCall({ args }) {
        const owner = args[args.indexOf("--assignee") + 1];
        if (args[3] === "update" && owner.startsWith(`omo:${old.attempt}:receipt:`)) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    const staleWrite = publishing.dispatched(id, old.attempt, {
      taskId: "st_retired_rail", toolCallId: "fixture-retired-call", outcome: "native-admitted",
    });
    const settled = Promise.allSettled([staleWrite]);
    let watchdog;
    try {
      await Promise.race([reached.promise,
        settled.then(() => assert.fail("Receipt settled before reaching the write barrier")),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new assert.AssertionError({
            message: "Receipt did not reach the guarded write",
          })), 4000);
        }),
      ]);
      const { details: observed } = await execute(newParent, newCtx, "show", { id });
      assert.equal(observed.assignee, `omo:${old.attempt}`);
      assert.equal(observed.status, "in_progress");
      assert.deepEqual(observed.metadata.qrclipWork.checked.receipt, oldCheck.receipt);
      const recovery = { id, assignee: observed.assignee, status: observed.status,
        reason: "The disposable rail worker stopped before the delayed receipt was delivered." };
      await assert.rejects(execute(newParent, newCtx, "recover", {
        ...recovery, confirmedStopped: false,
      }), { code: "recovery" });
      const { details: reopened } = await execute(newParent, newCtx, "recover", {
        ...recovery, confirmedStopped: true,
      });
      assert.equal(reopened.status, "open");
      assert.equal(reopened.notes.find(note => note.kind === "recovery").previousAttempt.id, old.attempt);
      const { stdout: comments } = await exec("bd", ["--sandbox", "comments", id, "--json"],
        { cwd, env, timeout: 3000 });
      const archived = JSON.parse(JSON.parse(comments).at(-1).text);
      assert.deepEqual(archived.previous.checked.receipt, oldCheck.receipt);
      await writeFile(join(cwd, source), replacement);
      const { details: next } = await execute(newParent, newCtx, "prepare", { id, mode: "delegate" });
      assert.notEqual(next.attempt, old.attempt);
      assert.equal(next.packet.attempt.coordinator, newActor);

      const replay = await newParent.emit(task({ prompt: old.marker }, "fixture-stale-marker"), newCtx);
      assert.equal(replay.block, true);
      assert.match(replay.reason, /marker is stale/);
      const wrongActor = await oldParent.emit(task({ prompt: next.marker }, "fixture-wrong-actor"), oldCtx);
      assert.equal(wrongActor.block, true);
      assert.match(wrongActor.reason, /only the preparing session/i);
      const current = task({ prompt: next.marker }, "fixture-new-call");
      assert.equal(await newParent.emit(current, newCtx), undefined);
      assert.equal(await newParent.emit(result(current, {
        task_id: "st_new_rail", status: "running",
      }), newCtx), undefined);
      const { details: before } = await execute(newParent, newCtx, "show", { id });
      assert.equal(before.status, "in_progress");
      assert.equal(before.assignee, `omo:${next.attempt}`);
      assert.equal(before.metadata.qrclipDispatch.taskId, "st_new_rail");

      release.resolve();
      await assert.rejects(staleWrite, error => {
        assert.equal(error.code, 13);
        const refusal = JSON.parse(error.stderr.trim().split("\n").at(-1));
        assert.equal(refusal.schema_version, 1);
        assert.deepEqual(refusal.failed, [{ id, guard_mismatch: true,
          error: `updating issue: assignee mismatch: ${id} is held by "omo:${next.attempt}", expected "omo:${old.attempt}"`,
        }]);
        return true;
      });
      const staleCallback = await oldParent.emit(lateResult, oldCtx);
      assert.equal(staleCallback?.isError, true, "Late callback must return a receipt error");
      assert.match(staleCallback.content.at(-1).text, /attempt is no longer owned/);
      await assert.rejects(execute(newParent, newCtx, "accept", { id, attempt: old.attempt }),
        { code: "ownership", message: /attempt is no longer owned/ });
      const { details: after } = await execute(newParent, newCtx, "show", { id });
      assert.deepEqual(after.metadata, before.metadata);
      assert.equal(after.assignee, before.assignee);
      assert.equal(after.status, before.status);

      await launch(worker, newWorker);
      const { details: checked } = await execute(worker, newWorker, "check", {
        id, attempt: next.attempt, kind: "functional", budgetMs: 5000,
        command: process.execPath, args: [...checkArgs, replacement],
      });
      assert.equal(checked.passed, true);
      assert.deepEqual(checked.sources, { [source]: sha256(replacement) });
      assert.notDeepEqual(checked.receipt, oldCheck.receipt);
      await assert.rejects(execute(oldParent, oldCtx, "accept", { id, attempt: next.attempt }),
        { code: "ownership", message: /only the coordinating session/i });
      const { details: accepted } = await execute(newParent, newCtx, "accept", { id, attempt: next.attempt });
      assert.deepEqual(accepted, { id, accepted: true });
      const { details: closed } = await execute(newParent, newCtx, "show", { id });
      assert.equal(closed.status, "closed");
      assert.equal(closed.assignee, `omo:${next.attempt}`);
      assert.deepEqual(closed.metadata.qrclipWork.accepted.receipt, checked.receipt);
      assert.deepEqual(await readFile(oldReceiptPath), oldReceipt);
    } finally {
      clearTimeout(watchdog);
      release.resolve();
      await settled;
    }
  });
