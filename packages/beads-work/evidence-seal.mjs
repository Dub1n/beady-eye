import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestLimit = 1024 * 1024;
const evidenceFileLimit = 256;
const pathByteLimit = 4095;
const pathComponentByteLimit = 255;
const fileByteLimit = 32 * 1024 * 1024;
const statusByteLimit = 64 * 1024;
const inspectorInputByteLimit = 1024 * 1024;
const inspectorOutputByteLimit = 512 * 1024;
const inspectionTimeoutMs = 10_000;
const digestPattern = /^[a-f0-9]{64}$/;
const helperPath = fileURLToPath(new URL("./evidence-seal-flags.py", import.meta.url));

class EvidenceSealError extends Error {
  name = "EvidenceSealError";
  code = "evidence-seal";
}

function reject(message) {
  throw new EvidenceSealError(message);
}

function canonicalRelative(value) {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > pathByteLimit ||
      value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    reject("Evidence paths must be bounded canonical project-relative paths.");
  }
  if (value.split("/").some(part => part === "" || part === "." || part === ".." ||
      Buffer.byteLength(part, "utf8") > pathComponentByteLimit)) {
    reject("Evidence paths cannot contain empty, dot, or parent components.");
  }
  return value;
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      Buffer.byteLength(value, "utf8") > pathByteLimit ||
      path.normalize(value) !== value || value.includes("\0")) {
    reject(`${label} must be a bounded canonical absolute path.`);
  }
  return value;
}

async function assertUnprivilegedProcess() {
  if (process.geteuid() === 0) reject("Evidence seals cannot run as effective uid 0.");
  const handle = await open("/proc/self/status", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(statusByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > statusByteLimit) reject("Process privilege status exceeded its bound.");
    const lines = buffer.toString("ascii", 0, bytesRead).split("\n");
    const capabilities = new Map();
    for (const line of lines) {
      const match = /^(CapEff|CapPrm):\s*([a-fA-F0-9]+)$/.exec(line);
      if (match) {
        if (capabilities.has(match[1])) reject("Process privilege status is ambiguous.");
        capabilities.set(match[1], BigInt(`0x${match[2]}`));
      }
    }
    const effective = capabilities.get("CapEff");
    const permitted = capabilities.get("CapPrm");
    if (effective === undefined || permitted === undefined) {
      reject("Process privilege status is incomplete.");
    }
    const forbiddenBits = [0, 1, 2, 3, 9, 21]
      .reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);
    if (((effective | permitted) & forbiddenBits) !== 0n) {
      reject("Evidence seals cannot run with filesystem or administrative capabilities.");
    }
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath, limit, retainBytes = false, expectedFact) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) {
      reject("Evidence inputs must be bounded regular files with one link.");
    }
    if (expectedFact && (info.uid !== expectedFact.uid || info.dev !== expectedFact.dev ||
        info.ino !== expectedFact.ino || info.size !== expectedFact.size)) {
      reject("Evidence input identity changed after path inspection.");
    }
    const initialMtime = info.mtimeMs;
    const initialCtime = info.ctimeMs;
    const digest = createHash("sha256");
    const chunks = retainBytes ? [] : null;
    let bytesRead = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > limit) reject("Evidence input exceeded its size bound.");
      digest.update(buffer.subarray(0, count));
      if (chunks) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = await handle.stat();
    if (after.dev !== info.dev || after.ino !== info.ino ||
        after.size !== bytesRead || after.mtimeMs !== initialMtime ||
        after.ctimeMs !== initialCtime) {
      reject("Evidence input changed while being read.");
    }
    return {
      digest: digest.digest("hex"),
      ...(chunks ? { bytes: Buffer.concat(chunks, bytesRead) } : {})
    };
  } finally {
    await handle.close();
  }
}

async function inspect(paths, projectRoot) {
  const input = JSON.stringify({ projectRoot, paths });
  if (Buffer.byteLength(input, "utf8") > inspectorInputByteLimit) {
    reject("Linux path inspection input exceeded its bound.");
  }
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  return await new Promise((resolve, rejectPromise) => {
    const child = spawn("/usr/bin/python3", ["-I", helperPath], {
      env: environment,
      cwd: "/",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks = [];
    let length = 0;
    let settled = false;
    const finishError = message => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectPromise(new EvidenceSealError(message));
    };
    const timer = setTimeout(() => finishError("Linux path inspection timed out."), inspectionTimeoutMs);
    child.stdout.on("data", chunk => {
      length += chunk.length;
      if (length > inspectorOutputByteLimit) {
        finishError("Linux path inspector exceeded its output bound.");
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => finishError("Linux path inspector could not start."));
    child.stdin.once("error", () => finishError("Linux path inspector closed its bounded input stream."));
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) rejectPromise(new EvidenceSealError("Linux immutable flag inspection failed closed."));
      else {
        try {
          const result = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
          if (!Array.isArray(result) || result.length !== paths.length) {
            reject("Linux path inspector returned incomplete data.");
          }
          resolve(result);
        } catch (error) {
          if (error instanceof EvidenceSealError) rejectPromise(error);
          else rejectPromise(new EvidenceSealError("Linux path inspector returned invalid data."));
        }
      }
    });
    child.stdin.end(input);
  });
}

export async function verifyEvidenceSeal({ projectRoot, manifestPath, archiveRoot, expectedFiles }) {
  if (process.platform !== "linux") {
    reject("Evidence seals require Linux and the isolated Python inspector.");
  }
  await assertUnprivilegedProcess();
  const project = canonicalAbsolute(projectRoot, "projectRoot");
  const manifest = canonicalAbsolute(manifestPath, "manifestPath");
  const archive = archiveRoot === undefined ? project : canonicalAbsolute(archiveRoot, "archiveRoot");
  const external = archiveRoot !== undefined;
  const relative = path.relative(project, archive);
  const reverseRelative = path.relative(archive, project);
  if (external && (relative === "" || reverseRelative === "" ||
      (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) ||
      (reverseRelative !== ".." && !reverseRelative.startsWith(".." + path.sep) &&
       !path.isAbsolute(reverseRelative)))) {
    reject("External archive root must be disjoint from projectRoot.");
  }
  if (!expectedFiles || typeof expectedFiles !== "object" || Array.isArray(expectedFiles)) {
    reject("expectedFiles must map canonical project-relative paths to SHA256 digests.");
  }
  const expectedEntries = Object.entries(expectedFiles);
  if (expectedEntries.length === 0 || expectedEntries.length > evidenceFileLimit) {
    reject("Evidence file count is outside the supported bounds.");
  }
  const expected = new Map();
  for (const [rawPath, digest] of expectedEntries) {
    const relpath = canonicalRelative(rawPath);
    if (expected.has(relpath) || typeof digest !== "string" || !digestPattern.test(digest)) {
      reject("Evidence paths and SHA256 digests must be unique and canonical.");
    }
    expected.set(relpath, digest);
  }
  try {
    if (await realpath(project) !== project || await realpath(manifest) !== manifest ||
        await realpath(archive) !== archive) {
      reject("Project and manifest paths must not traverse symlinks.");
    }
  } catch (error) {
    if (error instanceof EvidenceSealError) throw error;
    reject("Project and manifest paths must not traverse symlinks.");
  }

  const pathSet = new Set();
  const addAncestors = absolutePath => {
    let current = path.parse(absolutePath).root;
    pathSet.add(current);
    for (const component of absolutePath.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      pathSet.add(current);
    }
  };
  addAncestors(archive);
  addAncestors(manifest);
  for (const relpath of expected.keys()) addAncestors(path.join(archive, relpath));
  if (pathSet.size > 2048 ||
      [...pathSet].some(candidate => Buffer.byteLength(candidate, "utf8") > pathByteLimit)) {
    reject("Evidence ancestry exceeds Linux path or inspector bounds.");
  }
  const paths = [...pathSet].sort((left, right) => {
    const depth = value => value.split(path.sep).length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
  const facts = await inspect(paths, archive);
  if (facts.some((fact, index) => !fact || fact.path !== paths[index] ||
      !Number.isInteger(fact.uid) || !Number.isInteger(fact.mode) ||
      !Number.isInteger(fact.flags) || !Number.isInteger(fact.dev) ||
      !Number.isInteger(fact.mountId) || !Number.isInteger(fact.ino) ||
      !Number.isInteger(fact.size) ||
      typeof fact.directory !== "boolean" || typeof fact.regular !== "boolean")) {
    reject("Linux path inspector returned unsupported path facts.");
  }
  const byPath = new Map(facts.map(fact => [fact.path, fact]));
  const projectFact = byPath.get(archive);
  const device = projectFact?.dev;
  const mountId = projectFact?.mountId;
  if (!device || !Number.isInteger(mountId) ||
      facts.some(fact => fact.dev !== device || fact.mountId !== mountId)) {
    reject("Evidence, manifest and ancestors must remain on one device and mount.");
  }
  if (projectFact.filesystem !== "ext4") reject("Evidence seal filesystem must be ext4.");
  if (!projectFact.directory) reject("Evidence root must be a directory.");
  const immutableFlag = 0x10;
  for (const fact of facts) {
    if (fact.path === "/") {
      if (fact.uid !== 0 || (fact.mode & 0o022) !== 0) {
        reject("Filesystem root must be root-owned and non-writable by ordinary users.");
      }
      continue;
    }
    if (fact.uid !== 0) reject("Evidence ancestry must be root-owned.");
    if (fact.path === manifest ||
        [...expected.keys()].some(relpath => fact.path === path.join(archive, relpath))) {
      if ((fact.flags & immutableFlag) === 0) {
        reject("Manifest and evidence files must carry the immutable flag.");
      }
    }
  }

  const manifestRead = await hashFile(manifest, manifestLimit, true);
  const manifestDigest = manifestRead.digest;
  const manifestFact = byPath.get(manifest);
  if (!manifestFact?.regular || manifestFact.uid !== 0 ||
      (manifestFact.flags & immutableFlag) === 0 ||
      manifestFact.ino === 0 || manifestFact.size > manifestLimit) {
    reject("Manifest must be a bounded root-owned immutable regular file.");
  }
  if ((await hashFile(manifest, manifestLimit, false, manifestFact)).digest !== manifestDigest) {
    reject("Evidence manifest changed while being read.");
  }
  let descriptor;
  try {
    descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.bytes));
  } catch {
    reject("Evidence manifest must be valid UTF-8 JSON.");
  }
  if (!descriptor || descriptor.version !== 1 || descriptor.project !== archive ||
      !descriptor.files || typeof descriptor.files !== "object" || Array.isArray(descriptor.files)) {
    reject("Evidence manifest has an unsupported schema or project root.");
  }

  const manifestEntries = Object.entries(descriptor.files);
  if (manifestEntries.length !== expected.size) {
    reject("Evidence manifest must exactly cover expectedFiles.");
  }
  const files = new Map();
  for (const [rawPath, digest] of manifestEntries) {
    const relpath = canonicalRelative(rawPath);
    if (files.has(relpath) || typeof digest !== "string" || !digestPattern.test(digest) ||
        expected.get(relpath) !== digest) {
      reject("Evidence manifest differs from expectedFiles.");
    }
    files.set(relpath, digest);
  }
  for (const [relpath, expectedDigest] of files) {
    const filePath = path.join(archive, relpath);
    const fact = byPath.get(filePath);
    if (!fact?.regular || fact.uid !== 0 || (fact.flags & immutableFlag) === 0) {
      reject("Every evidence file must be a regular immutable file.");
    }
    if ((await hashFile(filePath, fileByteLimit, false, fact)).digest !== expectedDigest) {
      reject("Evidence bytes differ from the immutable manifest.");
    }
  }
  if ((await hashFile(manifest, manifestLimit, false, manifestFact)).digest !== manifestDigest) {
    reject("Evidence manifest changed during verification.");
  }

  return Object.freeze({
    version: 1,
    manifestSha256: manifestDigest,
    fileCount: files.size,
    ...(external && { archiveRoot: archive }),
    constraints: Object.freeze([
      "Linux ext4 immutable flags required",
      "immutable entries or root-owned non-writable parents required",
      "unchanged single device and mount assumed",
      "ordinary non-elevated writers only",
      "Windows writes must traverse the Linux ext4 VFS",
      "256 files, 1 MiB manifest, 32 MiB per file",
      "4095-byte paths, 255-byte components, 10-second inspector deadline"
    ])
  });
}
