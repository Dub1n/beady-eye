#!/usr/bin/env node
// Disposable test proxy. Its invocation path has an adjacent .json configuration;
// the real backend still owns every issue and transition.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, rename } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

const config = JSON.parse(await readFile(process.argv[1] + ".json", "utf8"));
const args = process.argv.slice(2);
if (config.environmentReceipt) await writeFile(config.environmentReceipt, JSON.stringify({
  keys: Object.keys(process.env).sort(),
  path: process.env.PATH,
  fixture: process.env.BEADS_WORK_FIXTURE,
  gitMaster: process.env.GIT_MASTER,
}));
// Entirely local store for isolation tests: never forwards to the real Beads DB.
if (config.mode === "disposable-store") {
  const state = JSON.parse(await readFile(config.state, "utf8"));
  const operation = args[args.indexOf("--actor") + 2];
  const id = args[args.indexOf("--actor") + 3];
  const value = state[id] ?? (config.resolvePrefixes
    ? Object.values(state).find(issue => issue.id.startsWith(id)) : undefined);
  if (operation === "show") {
    process.stdout.write(JSON.stringify(value ? [value] : []));
  } else if (operation === "update" && value) {
    for (const [guard, field] of [["--if-assignee", "assignee"], ["--if-status", "status"]]) {
      if (args.includes(guard) && value[field] !== args[args.indexOf(guard) + 1])
        throw new Error("Disposable store ownership mismatch");
    }
    for (const [flag, field] of [["--assignee", "assignee"], ["--status", "status"]])
      if (args.includes(flag)) value[field] = args[args.indexOf(flag) + 1];
    if (args.includes("--metadata"))
      value.metadata = { ...value.metadata, ...JSON.parse(args[args.indexOf("--metadata") + 1]) };
    await writeFile(config.state, JSON.stringify(state));
    process.stdout.write(JSON.stringify([value]));
  } else {
    throw new Error("Unsupported disposable store operation");
  }
  process.exit(0);
}
const update = args.includes("update");
const refreshComment = args.includes("comments") && args.includes("add") &&
  args.some(arg => arg.includes('"operation":"refresh-first-case"'));
const gate = config.mode === "first-update" ? update :
  ["refresh-before-comment", "committed-refresh-comment"].includes(config.mode) ? refreshComment :
  config.mode === "refresh-after-comment" ? update && args.includes("--status") &&
    args[args.indexOf("--status") + 1] === "open" && args.some(arg => arg.includes('"retiredArtifacts"')) :
  config.mode === "refresh-copy" ? update && args.some(arg => arg.includes('"phase":"copying"')) :
  config.mode === "close-update" ? update && args.includes("closed") :
    config.mode === "committed-close" ? update && args.includes("closed") :
    config.mode === "checked-update" ? update && args.some(arg => arg.includes('"checked"')) :
      config.mode === "committed-release" && update &&
        args[args.indexOf("--status") + 1] === "in_progress" &&
        args.includes("--assignee") && !args.includes("--metadata");

if (config.mode === "overflow-comments" && args.includes("comments")) {
  process.stdout.write(" ".repeat(2 * 1024 * 1024 + 1024));
} else {
  let committed;
  let alreadyReached = false;
  if (gate) {
    try { await access(config.ready); alreadyReached = true; }
    catch (error) {
      if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
    }
  }
  if (gate && !alreadyReached) {
    if (["committed-release", "committed-close", "committed-refresh-comment", "refresh-copy"].includes(config.mode)) {
      committed = await promisify(execFile)("bd", args, {env: process.env, timeout: 12000});
    }
    const publication = config.ready + "." + process.pid + ".partial";
    await writeFile(publication, ["checked-update", "refresh-copy"].includes(config.mode)
      ? args[args.indexOf("--metadata") + 1] : "boundary reached");
    await rename(publication, config.ready);
    await new Promise((resolve, reject) => {
      const watcher = watch(path.dirname(config.release), inspect);
      const timer = setTimeout(() => finish(new Error("Interleaving release deadline exceeded")), 10000);
      function finish(error) {
        clearTimeout(timer);
        watcher.close();
        if (error) reject(error);
        else resolve();
      }
      function inspect() {
        access(config.release).then(() => finish(), error => {
          if (!(error instanceof Error) || error.code !== "ENOENT") finish(error);
        });
      }
      watcher.on("error", finish);
      inspect();
    });
  }
  try {
    if (["refresh-before-comment", "refresh-after-comment", "committed-refresh-comment"].includes(config.mode) &&
        gate && !alreadyReached)
      throw Object.assign(new Error("Injected refresh interruption: " + config.mode), {
        code: 1, stderr: "Injected refresh interruption: " + config.mode,
      });
    if (["committed-release", "committed-close"].includes(config.mode) && gate && !alreadyReached)
      throw Object.assign(new Error(config.mode === "committed-close"
        ? "Injected lost close response" : "Injected lost release response"), {code: 1});
    const result = committed || await promisify(execFile)("bd", args, {
      env: process.env, timeout: 12000, maxBuffer: 2 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (typeof error.stdout === "string") process.stdout.write(error.stdout);
    if (typeof error.stderr === "string") process.stderr.write(error.stderr);
    process.exitCode = Number.isInteger(error.code) ? error.code : 1;
  }
}
