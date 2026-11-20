import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { test } from "node:test";
import { attempt, attempt2, execute, host, launch, primary, prompt, result, sandbox,
  secondary, task } from "./host.mjs";

test("native batch details publish ordered reservations and distinguish a native rejection with isError=false",
  { timeout: 6000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await project.prepare(secondary, attempt2);
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const prompts = [prompt(), prompt(secondary, attempt2)];
    const event = task({ tasks: prompts.map(value => ({ prompt: value })),
      subagent_type: "beads-coordinator" });
    assert.equal(await h.emit(event, ctx), undefined);
    for (const [index, item] of event.input.tasks.entries()) {
      assert.ok(item.prompt.startsWith(prompts[index] + "\n\n<beads_work_context>\n"));
      const packet = JSON.parse(item.prompt.split("\n", 5)[4]);
      assert.equal(packet.attempt.id, [attempt, attempt2][index]);
    }
    const native = result(event, { items: [
      { task_id: "st_orchard_1", status: "running" },
      { status: "error", error_message: "Native runner refused the second item." },
    ] });

    assert.equal(await h.emit(native, ctx), undefined);
    const { content, details, isError } = native;
    const digest = createHash("sha256").update(JSON.stringify({ content, details, isError })).digest("hex");
    const attempts = [{ id: primary, attempt }, { id: secondary, attempt: attempt2 }];
    const [start, end] = h.entries.slice(1);
    assert.equal(start.customType, "qrclip-beads-dispatch-start");
    assert.equal(end.customType, "qrclip-beads-dispatch-result");
    assert.equal(JSON.stringify(start.data), JSON.stringify({ toolCallId: event.toolCallId, attempts }));
    assert.equal(JSON.stringify(end.data),
      JSON.stringify({ toolCallId: event.toolCallId, attempts, isError: false, failures: [] }));
    for (const [index, expected] of [
      { taskId: "st_orchard_1", error: null, nativeStatus: "running", outcome: "native-admitted" },
      { taskId: null, error: "Native runner refused the second item.", nativeStatus: "error", outcome: "native-error" },
    ].entries()) {
      const marker = attempts[index];
      const issue = await project.issue(marker.id);
      const { recordedAt, ...receipt } = issue.metadata.qrclipDispatch;
      assert.ok(Number.isFinite(Date.parse(recordedAt)));
      assert.deepEqual(receipt, { attemptId: marker.attempt, childSession: null,
        toolCallId: event.toolCallId, resultSha256: digest, ...expected });
      assert.equal(issue.status, expected.error ? "blocked" : "in_progress");
    }
  });

test("a revoked session finishes an admitted receipt and rejects new operations and task admissions",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await project.prepare(secondary, attempt2);
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const admitted = task({ prompt: prompt() });
    assert.equal(await h.emit(admitted, ctx), undefined);
    for (const type of ["session_before_switch", "session_before_fork", "session_before_reload"])
      assert.equal(h.emit({ type }, ctx).cancel, true);
    await s.policy([{ root: project.cwd, level: "disabled" }]);

    const callback = result(admitted, { status: "completed", task_id: "st_harbor_1" });
    assert.equal(await h.emit(callback, ctx), undefined);
    assert.equal((await project.issue()).metadata.qrclipDispatch.outcome, "native-admitted");
    assert.equal(h.emit({ type: "session_before_reload" }, ctx), undefined);
    const reopened = host();
    const continued = reopened.ctx(project.cwd, ctx.sessionManager.getSessionId(), h.entries);
    await launch(reopened, continued);
    const commandCount = (await project.calls()).length;
    for (const [index, newPrompt] of [prompt(secondary, attempt2), "ordinary task"].entries())
      assert.match((await reopened.emit(task({ prompt: newPrompt }, `new-${index}`), continued)).reason,
        /requires delegation/);
    await assert.rejects(execute(h, ctx, "limits"), /requires observation/);
    assert.equal((await project.calls()).length, commandCount);
    assert.equal((await project.issue(secondary)).status, "hooked");
  });

test("a stale native result cannot publish into a different session",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const event = task({ prompt: prompt() });
    assert.equal(await h.emit(event, ctx), undefined);
    await launch(h, h.ctx(project.cwd, "replacement-session"));

    const reply = await h.emit(result(event, { task_id: "st_late", status: "running" }), ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.content.at(-1).text, /Session changed or is unavailable/);
    assert.equal((await project.issue()).metadata.qrclipDispatch, undefined);
    assert.equal(h.entries.some(entry => entry.customType === "qrclip-beads-dispatch-result"), false);
  });

test("a same-path store replacement leaves an admitted attempt for explicit recovery",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const event = task({ prompt: prompt() });
    assert.equal(await h.emit(event, ctx), undefined);
    const original = await project.issue();
    await rename(project.workspace, project.workspace + ".retired");
    await s.project("harbor");
    await project.save(original);

    const reply = await h.emit(result(event, { task_id: "st_late", status: "running" }), ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.content.at(-1).text, /store binding changed/);
    assert.deepEqual(await project.calls(), []);
    assert.equal((await project.issue()).metadata.qrclipDispatch, undefined);
  });

test("a session journal failure blocks native launch and records a non-replayable preflight failure",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host({ record(customType) {
      if (customType === "qrclip-beads-dispatch-start") throw new Error("Invented journal failure.");
    } });
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const event = task({ prompt: prompt() });

    const blocked = await h.emit(event, ctx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Invented journal failure/);
    const issue = await project.issue();
    assert.equal(issue.status, "blocked");
    assert.equal(issue.metadata.qrclipDispatch.outcome, "preflight-failed");
    assert.equal(issue.metadata.qrclipDispatch.toolCallId, event.toolCallId);
    assert.match((await h.emit(task({ prompt: prompt() }, "replayed"), ctx)).reason, /marker is stale/);
  });

test("a result that lost its attempt owner returns an explicit receipt error without adopting the new attempt",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);
    const event = task({ prompt: prompt() });
    assert.equal(await h.emit(event, ctx), undefined);
    await project.prepare(primary, attempt2);
    const replacement = await project.issue();

    const reply = await h.emit(result(event, { task_id: "st_late", status: "running" }), ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.content.at(-1).text, /attempt is no longer owned/);
    assert.deepEqual(await project.issue(), replacement);
    const sessionReceipt = h.entries.at(-1);
    assert.equal(sessionReceipt.customType, "qrclip-beads-dispatch-result");
    assert.equal(sessionReceipt.data.failures.length, 1);
    assert.match(sessionReceipt.data.failures[0], /attempt is no longer owned/);
  });
