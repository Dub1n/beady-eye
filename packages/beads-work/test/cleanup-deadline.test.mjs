import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkTracker } from "../agent-work.mjs";

test("expired primary command still runs separately reserved cleanup", async t => {
  // This case tests the command and cleanup deadlines, not Dolt startup.
  // Seed a direct attempt in the disposable CAS store so the primary actually
  // starts even on hosts where tracker reads can exhaust a 5-second budget.
  const directory = await mkdtemp(path.join(tmpdir(), "beads-cleanup-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "bd-fixture");
  const state = path.join(directory, "state.json");
  const attempt = "11111111-1111-4111-8111-111111111111";
  await writeFile(binary, await readFile(new URL("./agent-work-test-bd.mjs", import.meta.url)), { mode: 0o700 });
  await writeFile(binary + ".json", JSON.stringify({ mode: "disposable-store", state }));
  await writeFile(state, JSON.stringify({ disposable: { id: "disposable", status: "in_progress",
    assignee: "omo:" + attempt, metadata: { qrclipWork: { version: 1, paths: [],
      attempt: { id: attempt, name: "disposable", mode: "direct", coordinator: "disposable" } } } } }));
  const tracker = createWorkTracker({ cwd: directory, actor: "disposable", binary });
  const cleanupPath = path.join(directory, "cleanup.txt");
  const proof = await tracker.check("disposable", attempt, {
    command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    budgetMs: 5000,
    cleanup: { command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(cleanupPath)}, "cleaned")`] },
  });
  assert.equal(proof.passed, false);
  assert.equal(await readFile(cleanupPath, "utf8"), "cleaned");
  const receipt = JSON.parse(await readFile(path.join(directory, proof.receipt.path), "utf8"));
  assert.equal(receipt.commands.find(command => command.label === "work-check").outcome, "timeout");
  assert.equal(receipt.commands.find(command => command.label === "work-cleanup").outcome, "exit");
});
