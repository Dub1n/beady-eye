import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWorkTracker } from "../agent-work.mjs";

test("short IDs cannot read or mutate a different full work item", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beads-work-short-id-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "bd-fixture");
  await writeFile(binary, await readFile(new URL("./agent-work-test-bd.mjs", import.meta.url)));
  await chmod(binary, 0o700);
  const statePath = path.join(directory, "state.json");
  const id = "bdi.abcdef123456";
  const issue = { id, status: "open", assignee: "", metadata: { qrclipWork: { version: 1, paths: [] } } };
  const original = JSON.stringify({ [id]: issue });
  await writeFile(statePath, original);
  await writeFile(binary + ".json", JSON.stringify({ mode: "disposable-store", state: statePath, resolvePrefixes: true }));
  const tracker = createWorkTracker({ cwd: directory, actor: "short-id-test", binary });

  await assert.rejects(tracker.issue("bdi.abc"), { code: "issue" });
  await assert.rejects(tracker.edit("bdi.abc", { title: "must not update" }), { code: "issue" });
  await assert.rejects(tracker.create({ title: "blocked work", objective: "test", blockedBy: ["bdi.abc"] }),
    { code: "issue" });
  assert.equal(await readFile(statePath, "utf8"), original);
});
