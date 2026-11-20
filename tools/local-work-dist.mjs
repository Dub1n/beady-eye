#!/usr/bin/env node

import { constants } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifestName = "work-dist.json";
const fixed = [
  "LICENSE", "FORK-NOTICES.md", "Cargo.toml", "Cargo.lock", "README.md",
  "benches/keystroke_survey.rs", "herdr/build.sh", "tools/local-work-dist.mjs",
  "tools/test-evidence-seal.mjs", "tools/test-evidence-seal.ps1",
  "docs/coordination-trial.md",
  ...["_work_sweep_capture_support.py", "_work_sweep_reader.py", "observe-work-pane.py",
    "observe_work_pane.py", "observe_work_pane_capture.py", "observe_work_pane_projection.py",
    "observe_work_pane_reader.py", "work_sweep.py", "work_sweep_capture.py",
    "work_sweep_driver_io.py", "work_sweep_events.py", "work_sweep_schedule.py",
    "work_trial_summary.py"].map(file => `tools/${file}`),
  "docs/local-work-distribution.md", "docs/work-integration.md", "docs/evidence-seal-test.md",
  ...["package.json", "cli.mjs", "agent-work-cli.mjs", "agent-work.mjs", "policy.mjs",
    "trusted-fixtures.mjs", "evidence-seal.mjs", "evidence-seal-flags.py",
    "harness-observation.mjs", "README.md"].map(file => `packages/beads-work/${file}`),
  ...["package.json", "index.mjs", "dispatch.mjs", "session.mjs", "tool.mjs", "README.md",
    "templates/qrclip-v1/omo.json", "templates/qrclip-v1/README.md"].map(file => `adapters/omo-work/${file}`),
  ...["package.json", "index.mjs", "io.mjs", "rpc.mjs", "work-policy.mjs", "README.md",
    "settings.example.json"].map(file => `adapters/omo-observer/${file}`),
];
const executable = new Set(["herdr/build.sh", "packages/beads-work/cli.mjs"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const modeOf = file => executable.has(file) ? 0o755 : 0o644;

class DistributionError extends Error {}

async function walk(root, relative = "") {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (!/^[A-Za-z0-9_./-]+$/.test(file)) throw new DistributionError(`Invalid package path: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new DistributionError(`Expected regular package file or directory: ${file}`);
  }
  return files.sort();
}

async function payload(root) {
  const rust = await walk(root, "src");
  if (!rust.includes("src/main.rs") || rust.some(file => !file.endsWith(".rs"))) {
    throw new DistributionError("Expected only Rust source files under src/.");
  }
  return [...fixed, ...rust].sort();
}

async function fingerprint(root, file, checkMode) {
  const path = join(root, file);
  const st = await lstat(path);
  if (!st.isFile() || st.nlink !== 1 || await realpath(path) !== path ||
      (checkMode && (st.mode & 0o777) !== modeOf(file))) {
    throw new DistributionError(`Invalid package file identity or mode: ${file}`);
  }
  return hash(await readFile(path));
}

async function verify(root, expected) {
  const manifestPath = join(root, manifestName);
  await fingerprint(root, manifestName, true);
  const bytes = await readFile(manifestPath);
  const digest = hash(bytes);
  if (digest !== expected) throw new DistributionError("Manifest does not match the requested pin.");
  const manifest = JSON.parse(bytes);
  const declared = Object.keys(manifest.files ?? {}).sort();
  const required = await payload(root);
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      JSON.stringify(declared) !== JSON.stringify(required) ||
      JSON.stringify(await walk(root)) !== JSON.stringify([...required, manifestName].sort())) {
    throw new DistributionError("Installed files do not match the release payload.");
  }
  for (const file of declared) {
    if (await fingerprint(root, file, true) !== manifest.files[file]) {
      throw new DistributionError(`File does not match the release pin: ${file}`);
    }
  }
  return digest;
}

async function assemble(out) {
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (out === root || out.startsWith(`${root}/`)) {
    throw new DistributionError("Use a distribution directory outside the source checkout.");
  }
  const version = (await readFile(join(root, "Cargo.toml"), "utf8")).match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
  if (!version) throw new DistributionError("Cannot read the bdi version from Cargo.toml.");
  const stage = await mkdtemp(join(out, ".beady-eye-work-"));
  try {
    const files = {};
    for (const file of await payload(root)) {
      files[file] = await fingerprint(root, file, false);
      const target = join(stage, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, file), target, constants.COPYFILE_EXCL);
      // Normalize checkout-dependent file modes without modifying the source.
      await chmod(target, modeOf(file));
      if (await fingerprint(root, file, false) !== files[file]) {
        throw new DistributionError(`Source changed while assembling: ${file}`);
      }
    }
    const bytes = `${JSON.stringify({ schemaVersion: 1, version, files }, null, 2)}\n`;
    const digest = hash(bytes);
    const manifestPath = join(stage, manifestName);
    await writeFile(manifestPath, bytes, { flag: "wx" });
    await chmod(manifestPath, modeOf(manifestName));
    await verify(stage, digest);
    const path = join(out, `beady-eye-work-${version}-${digest}`);
    await rename(stage, path);
    return { path, version, sha256: digest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const [command, path, expected, extra] = process.argv.slice(2);
if (!path || !isAbsolute(path) || extra !== undefined ||
    !((command === "assemble" && expected === undefined) ||
      (command === "verify" && /^[a-f0-9]{64}$/.test(expected ?? "")))) {
  throw new DistributionError("Use assemble ABSOLUTE_PARENT or verify ABSOLUTE_RELEASE_DIR MANIFEST_SHA256.");
}
const directory = await realpath(path);
if (directory !== path || !(await lstat(directory)).isDirectory()) {
  throw new DistributionError("Use a canonical directory path.");
}
const result = command === "assemble" ? await assemble(directory) :
  { path: directory, sha256: await verify(directory, expected) };
console.log(JSON.stringify(result));
