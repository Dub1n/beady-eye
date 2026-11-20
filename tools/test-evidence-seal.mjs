#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stop = (message) => {
  console.error(`evidence-seal-test: ${message}`);
  process.exit(2);
};
const [rootArg, outputArg, ...extra] = process.argv.slice(2);
if (!rootArg || !outputArg || extra.length) {
  stop("usage: node tools/test-evidence-seal.mjs /var/lib/beady-eye-seal-test.<8 chars> NEW_OUTPUT_DIR");
}

const root = rootArg;
if (root !== path.resolve(root) || !/^\/var\/lib\/beady-eye-seal-test\.[A-Za-z0-9]{8}$/.test(root)) {
  stop("root must be the canonical staged /var/lib path");
}
const output = path.resolve(outputArg);
if (output !== outputArg || output === root || output.startsWith(`${root}/`) || root.startsWith(`${output}/`)) {
  stop("output must be a distinct canonical path outside the staged root");
}
const outputParent = path.dirname(output);
if (await realpath(outputParent).catch(() => "") !== outputParent) stop("output parent must already exist as a real canonical directory");
const outputParentInfo = await lstat(outputParent).catch(() => stop("output parent is unavailable"));
if (!outputParentInfo.isDirectory() || outputParentInfo.isSymbolicLink()) stop("output parent must be a real directory");
if (process.platform !== "linux" || process.getuid() === 0) stop("requires an ordinary non-root Linux process");
if (await realpath("/var/lib").catch(() => "") !== "/var/lib") stop("/var/lib must be a real canonical directory");
const varLibInfo = await lstat("/var/lib");
if (!varLibInfo.isDirectory() || varLibInfo.isSymbolicLink() || varLibInfo.uid !== 0 ||
    (varLibInfo.mode & 0o022) !== 0) stop("/var/lib must be root-owned and not group/world writable");

const project = `${root}/project`;
const evidence = `${project}/evidence`;
const receipt = `${evidence}/receipt.txt`;
const manifest = `${root}/manifest.json`;
const expectedText = "Invented sealed evidence only.\n";
const expectedHash = createHash("sha256").update(expectedText).digest("hex");
const expectedManifest = `{"version":1,"project":"${root}/project","files":{"evidence/receipt.txt":"${expectedHash}"}}\n`;
const shape = [
  [root, "directory", 0o755],
  [project, "directory", 0o755],
  [evidence, "directory", 0o755],
  [receipt, "file", 0o644],
  [manifest, "file", 0o644],
];
for (const [p, kind, mode] of shape) {
  const st = await lstat(p).catch(() => stop(`missing staged path: ${p}`));
  if ((kind === "directory" ? !st.isDirectory() : !st.isFile()) || st.isSymbolicLink() ||
      st.uid !== 0 || (st.mode & 0o777) !== mode) stop(`unexpected type, owner, or mode: ${p}`);
}
if (!(await readFile(receipt)).equals(Buffer.from(expectedText))) stop("receipt bytes differ from the invented fixture");
if (!(await readFile(manifest)).equals(Buffer.from(expectedManifest))) stop("manifest bytes differ from the exact expected manifest");
for (const p of [root, project, evidence, receipt, manifest]) {
  if (await realpath(p) !== p) stop(`non-canonical staged path: ${p}`);
}
try {
  await lstat(output);
  stop("output path already exists; choose a new private output path");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const attrs = spawnSync("/usr/bin/lsattr", ["-d", receipt, manifest], { encoding: "utf8" });
if (attrs.error || attrs.status !== 0 || attrs.stdout.trim().split("\n").length !== 2 ||
    attrs.stdout.trim().split("\n").some((line) => !/^-+i[-+A-Za-z]*\s/.test(line))) {
  stop("lsattr must confirm immutable flags on both exact files");
}

await mkdir(output, { mode: 0o700 });
const checks = [];
const report = async (passed, reason) => {
  const result = {
    version: 1, platform: process.platform, uid: process.getuid(),
    root, output, checks, controls: { ordinaryRead: false, writableScratch: false },
    originalBytesUnchanged: false, passed,
  };
  if (reason) result.failure = reason;
  await writeFile(path.join(output, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
};
const expectDenied = async (name, operation) => {
  try {
    await operation();
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error.code)) {
      checks.push({ name, result: "denied", code: error.code });
      return;
    }
    checks.push({ name, result: "error", code: error.code ?? null });
    await report(false, `${name} returned an ambiguous error`);
    process.exit(1);
  }
  checks.push({ name, result: "unexpected-success" });
  await report(false, `${name} unexpectedly succeeded; stop and preserve evidence`);
  process.exit(1);
};

const scratch = path.join(output, "scratch");
const replacement = path.join(output, "replacement");
await mkdir(scratch, { mode: 0o700 });
await writeFile(replacement, "replacement\n", { mode: 0o600 });
const unlocked = spawnSync("/usr/bin/chattr", ["-i", receipt], { encoding: "utf8" });
if (unlocked.error || unlocked.status === null) stop("could not execute ordinary chattr -i probe");
if (unlocked.status === 0) {
  checks.push({ name: "chattr-remove-immutable-receipt-only", result: "unexpected-success" });
  await report(false, "ordinary chattr -i unexpectedly succeeded; stopped immediately");
  process.exit(1);
}
if (!/operation not permitted|permission denied|not permitted/i.test(unlocked.stderr)) {
  await report(false, "chattr -i result was not an explicit ordinary permission denial");
  process.exit(1);
}
checks.push({ name: "chattr-remove-immutable-receipt-only", result: "denied", status: unlocked.status });

for (const file of [receipt, manifest]) {
  const name = path.basename(file);
  await expectDenied(`write-open:${name}`, async () => {
    const handle = await open(file, "r+");
    await handle.close();
  });
  await expectDenied(`rename-replacement:${name}`, () => rename(replacement, file));
  await expectDenied(`delete:${name}`, () => rm(file));
}
await expectDenied("replace-project-parent", () => rename(project, `${root}/project.replacement`));
await expectDenied("replace-evidence-parent", () => rename(evidence, `${project}/evidence.replacement`));

if (!(await readFile(receipt)).equals(Buffer.from(expectedText)) ||
    !(await readFile(manifest)).equals(Buffer.from(expectedManifest))) {
  await report(false, "original fixture bytes changed");
  process.exit(1);
}
const finalAttrs = spawnSync("/usr/bin/lsattr", ["-d", receipt, manifest], { encoding: "utf8" });
if (finalAttrs.error || finalAttrs.status !== 0 || finalAttrs.stdout.trim().split("\n").length !== 2 ||
    finalAttrs.stdout.trim().split("\n").some((line) => !/^-+i[-+A-Za-z]*\s/.test(line))) {
  await report(false, "immutable flags did not remain set on both exact files");
  process.exit(1);
}
const readHandle = await readFile(receipt, "utf8");
if (readHandle !== expectedText) {
  await report(false, "ordinary read control failed");
  process.exit(1);
}
await writeFile(path.join(scratch, "positive-control.txt"), "ordinary scratch write succeeded\n", { mode: 0o600 });
if ((await readFile(path.join(scratch, "positive-control.txt"), "utf8")) !== "ordinary scratch write succeeded\n") {
  await report(false, "writable scratch control failed");
  process.exit(1);
}
const result = {
  version: 1, platform: process.platform, uid: process.getuid(), root, output, checks,
  controls: { ordinaryRead: true, writableScratch: true },
  originalBytesUnchanged: true, passed: true,
};
await writeFile(path.join(output, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result));
await rm(scratch, { recursive: true });
