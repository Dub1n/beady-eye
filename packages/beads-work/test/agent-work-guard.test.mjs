import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkTracker } from "../agent-work.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beads-work-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "bd-fixture");
  await writeFile(binary, await readFile(new URL("./agent-work-test-bd.mjs", import.meta.url)));
  await chmod(binary, 0o700);
  const state = path.join(directory, "state.json");
  const receipt = path.join(directory, "environment.json");
  const id = "bdi.hook123";
  const issue = { id, status: "open", assignee: "", metadata: { qrclipWork: { version: 1, paths: [] } } };
  await writeFile(state, JSON.stringify({ [id]: issue }));
  await writeFile(binary + ".json", JSON.stringify({ mode: "disposable-store", state, environmentReceipt: receipt }));
  return { directory, binary, state, receipt, id, issue };
}

test("beforeCall can reject a bd command before the child starts", async t => {
  const f = await fixture(t);
  const calls = [];
  const tracker = createWorkTracker({ cwd: f.directory, actor: "hook-test", binary: f.binary,
    env: { PATH: process.env.PATH, BEADS_WORK_FIXTURE: "controlled" },
    beforeCall: ({ args }) => { calls.push(args); throw new Error("policy blocked"); } });

  await assert.rejects(tracker.issue(f.id), /policy blocked/);
  assert.deepEqual(calls, [["--sandbox", "--actor", "hook-test", "show", f.id, "--json"]]);
  await assert.rejects(readFile(f.receipt), { code: "ENOENT" });
});

test("custom bd environment is isolated and retains GIT_MASTER", async t => {
  const f = await fixture(t);
  const calls = [];
  const env = { PATH: process.env.PATH, BEADS_WORK_FIXTURE: "controlled" };
  const tracker = createWorkTracker({ cwd: f.directory, actor: "hook-test", binary: f.binary, env,
    beforeCall: ({ args }) => { calls.push(args); } });

  assert.deepEqual(await tracker.issue(f.id), f.issue);
  assert.deepEqual(calls, [["--sandbox", "--actor", "hook-test", "show", f.id, "--json"]]);
  assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), {
    keys: ["BEADS_WORK_FIXTURE", "GIT_MASTER", "PATH"],
    path: env.PATH,
    fixture: "controlled",
    gitMaster: "1",
  });
});
