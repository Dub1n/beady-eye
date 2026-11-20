import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function observe(directory, predicate) {
  return new Promise((resolve, reject) => {
    const check = () => {
      void readdir(directory).then(names => {
        if (predicate(names)) finish(resolve);
      }, error => finish(() => reject(error)));
    };
    const watcher = watch(directory, check);
    const timer = setTimeout(() => finish(() => reject(new Error("No matching observer frame transition"))), 5000);
    function finish(callback) {
      watcher.close();
      clearTimeout(timer);
      callback();
    }
    check();
  });
}

test("installed observer uses the configured policy and removes its frame after revocation", { timeout: 16_000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bdi-policy-observer-"));
  const [pkg, project, tasks, frames, evaluator, grant] = ["package", "orchard", "tasks", "frames", "evaluator", "grant.json"]
    .map(name => join(root, name));
  const hooks = new Map();
  t.after(async () => {
    await hooks.get("session_shutdown")?.();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(pkg);
  for (const file of ["index.mjs", "io.mjs", "rpc.mjs", "work-policy.mjs"]) {
    await cp(new URL(`../${file}`, import.meta.url), join(pkg, file));
  }
  await Promise.all([mkdir(project), mkdir(tasks), mkdir(frames, { mode: 0o700 })]);
  const setGrant = level => writeFile(grant, JSON.stringify({ version: 1, project, level }));
  await setGrant("observation");
  await writeFile(evaluator, `#!${process.execPath}\nconst fs=require("node:fs");
if(process.argv[2]!=="policy"||process.cwd()!==${JSON.stringify(project)})process.exit(1);
process.stdout.write(fs.readFileSync(${JSON.stringify(grant)}));`, { mode: 0o700 });
  await writeFile(join(pkg, "settings.json"), JSON.stringify({
    project: "orchard", projectDirectory: project, taskDirectory: tasks, directory: frames,
    workPolicyExecutable: evaluator,
  }));
  const { default: install } = await import(pathToFileURL(join(pkg, "index.mjs")).href);
  await install({ events: new EventEmitter(), on: (name, callback) => hooks.set(name, callback) });
  const frame = names => names.find(name => name.startsWith("frame-") && name.endsWith(".json"));
  const published = observe(frames, frame);
  hooks.get("session_start")({}, { cwd: project, isIdle: () => true,
    sessionManager: { getSessionId: () => "invented-coordinator" } });
  await published;
  const snapshot = JSON.parse(await readFile(join(frames, frame(await readdir(frames))), "utf8"));
  assert.deepEqual(snapshot.scope, { project: "orchard", taskDirectory: tasks });
  const withdrawn = observe(frames, names => !frame(names));
  await setGrant("disabled");
  await withdrawn;
});
