import assert from "node:assert/strict";
import { test } from "node:test";
import { attempt, execute, host, launch, primary, prompt, sandbox, task } from "./host.mjs";

test("entry registers one tool per host and uses the real callback project and actor",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const first = await s.project("harbor");
    const second = await s.project("orchard");
    await first.prepare();
    await second.prepare();
    await s.policy([{ root: first.cwd, level: "observation" }, { root: second.cwd, level: "observation" }]);
    const h = host();
    h.reload();
    assert.equal(h.tools.length, 1);
    const ctx = h.ctx(second.cwd, "orchard-session");
    await launch(h, ctx);

    assert.equal((await execute(h, ctx, "show", { id: primary, actor: "from-payload",
      cwd: first.cwd })).details.title, "orchard");
    assert.deepEqual(await first.calls(), []);
    assert.deepEqual((await second.calls()).filter(call => call[1] === "--actor"),
      [["--sandbox", "--actor", "orchard-session", "show", primary, "--json"]]);
  });

test("the same full ID in a different project cannot authorize a cross-project marker",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const first = await s.project("harbor");
    const second = await s.project("orchard");
    await first.prepare();
    await second.prepare(primary, "4cd57686-f030-42e4-94bf-10a860a354f5", "orchard-session");
    await s.policy([{ root: first.cwd, level: "delegation" }, { root: second.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(second.cwd, "orchard-session");
    await launch(h, ctx);
    const event = task({ prompt: prompt(), cwd: first.cwd });

    assert.match((await h.emit(event, ctx)).reason, /marker is stale or already dispatched/);
    assert.deepEqual(await first.calls(), []);
    assert.equal((await second.issue()).status, "hooked");
  });

test("a prepared attempt belongs to the native actor even when its marker is valid",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await project.prepare();
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd, "other-session");
    await launch(h, ctx);

    assert.match((await h.emit(task({ prompt: prompt() }), ctx)).reason, /Only the preparing session/);
    assert.equal((await project.issue()).status, "hooked");
  });

test("a nested Git checkout without a store is inactive and does not fall back to its ancestor",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const first = await s.project("harbor");
    const nested = await s.project("harbor/archive", { store: false });
    await s.policy([{ root: first.cwd, level: "delegation" }, { root: nested.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(nested.cwd);
    await launch(h, ctx);

    assert.equal(await h.emit(task({ prompt: "ordinary task" }), ctx), undefined);
    assert.match((await h.emit(task({ prompt: prompt() }), ctx)).reason, /own real local \.beads/);
    await assert.rejects(execute(h, ctx, "limits"), /own real local \.beads/);
    assert.deepEqual(await first.calls(), []);
    assert.deepEqual(h.entries, []);
  });

test("enabled delegation refuses markerless task calls without authorizing an issue lookup",
  { timeout: 5000 }, async t => {
    const s = await sandbox(t);
    const project = await s.project("harbor");
    await s.policy([{ root: project.cwd, level: "delegation" }]);
    const h = host();
    const ctx = h.ctx(project.cwd);
    await launch(h, ctx);

    assert.match((await h.emit(task({ prompt: "unprepared", subagent_type: "beads-coordinator" }), ctx)).reason,
      /fresh prepared work marker/);
    assert.deepEqual((await project.calls()).filter(call => call[1] === "--actor"), []);
  });

test("explicit non-delegation grants leave ordinary calls alone and reject prepared dispatches",
  { timeout: 7000 }, async t => {
    const s = await sandbox(t);
    const cases = [];
    for (const level of ["disabled", "observation", "management"]) {
      const project = await s.project(level);
      const session = `fresh-${level}-session`;
      await project.prepare(primary, attempt, session);
      cases.push({ level, project, session });
    }
    await s.policy(cases.map(({ level, project }) => ({ root: project.cwd, level })));

    for (const { level, project, session } of cases) {
      const h = host();
      const ctx = h.ctx(project.cwd, session);
      await launch(h, ctx);

      assert.equal(await h.emit(task({ prompt: "ordinary native task" }), ctx), undefined, level);
      const blocked = await h.emit(task({ prompt: prompt() }, `marked-${level}`), ctx);
      assert.equal(blocked.block, true, level);
      assert.match(blocked.reason, /requires delegation/, level);
      assert.deepEqual((await project.calls()).filter(call => call[1] === "--actor"), [], level);
      assert.deepEqual(h.entries, [], level);
    }
  });
