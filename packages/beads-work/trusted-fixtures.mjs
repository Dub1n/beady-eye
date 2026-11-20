import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const descriptorLimit = 64 * 1024;
const executableLimit = 128 * 1024 * 1024;
const inputBatchLimit = 64 * 1024 * 1024;
const inputFileLimit = 32 * 1024 * 1024;
const fixtureId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^[a-f0-9]{64}$/;

class TrustedFixtureError extends Error {
  name = "TrustedFixtureError";
  code = "trusted-fixture";
}

function reject(message) {
  throw new TrustedFixtureError(message);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function duplicateCheckedJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reject("Trusted fixture descriptor must be UTF-8 JSON.");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reject("Trusted fixture descriptor must be valid JSON.");
  }
  const objects = [];
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (token[0] === "{") objects.push(new Set());
    else if (token[0] === "}") objects.pop();
    else if (token[1]) {
      const keys = objects.at(-1);
      const key = JSON.parse(token[0].slice(0, -1));
      if (keys.has(key)) reject("Trusted fixture descriptor cannot contain duplicate keys.");
      keys.add(key);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("Trusted fixture descriptor must be an object.");
  return value;
}

async function pinnedFile(filePath, limit, role, executable = false) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0"))
    reject(`Trusted fixture ${role} path must be absolute.`);
  if (await realpath(filePath) !== filePath)
    reject(`Trusted fixture ${role} path cannot use symbolic links or noncanonical aliases.`);
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) reject(`Trusted fixture ${role} must be a regular file.`);
    if (before.nlink !== 1n) reject(`Trusted fixture ${role} must have exactly one hard link.`);
    if (before.size > BigInt(limit)) reject(`Trusted fixture ${role} exceeds its byte limit.`);
    if (executable && (before.mode & 0o111n) === 0n)
      reject(`Trusted fixture ${role} must be executable on this host.`);
    const chunks = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > limit) reject("Trusted fixture file exceeds its byte limit.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    if (size !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1n)
      reject("Trusted fixture file changed while it was being verified.");
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAre(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative);
}

function action(value) {
  if (!object(value) || !keysAre(value, ["executable", "sha256", "args"]) ||
      typeof value.executable !== "string" || !path.isAbsolute(value.executable) ||
      value.executable.includes("\0") || !digestPattern.test(value.sha256) ||
      !Array.isArray(value.args) || value.args.length > 128 ||
      value.args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) ||
      value.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 16 * 1024)
    reject("Trusted fixture actions need an absolute executable, byte pin and bounded arguments.");
  if (value.executable === "/init")
    reject("The /init wrapper form is outside descriptor v1 because its Windows helper is not independently pinned.");
  return Object.freeze({ executable: value.executable, sha256: value.sha256,
    args: Object.freeze([...value.args]) });
}

function environment(value) {
  if (!object(value) || Object.keys(value).length > 32 ||
      Object.entries(value).some(([key, item]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) ||
        typeof item !== "string" || item.length > 8192 || item.includes("\0")) ||
      Object.entries(value).reduce((total, [key, item]) =>
        total + Buffer.byteLength(key) + Buffer.byteLength(item), 0) > 16 * 1024)
    reject("Trusted fixture environment must be an explicit bounded string map.");
  return Object.freeze({ ...value });
}

async function projectInputs(value, root) {
  if (!Array.isArray(value) || value.length > 32)
    reject("Trusted fixture projectInputs must contain at most 32 pinned files.");
  const seen = new Set();
  let total = 0;
  const inputs = [];
  for (const item of value) {
    if (!object(item) || !keysAre(item, ["path", "sha256"]) ||
        typeof item.path !== "string" || item.path.length > 512 ||
        item.path.includes("\0") || item.path.includes("\\") || path.isAbsolute(item.path) ||
        item.path.split("/").some(part => !part || part === "." || part === "..") ||
        item.path !== path.posix.normalize(item.path) || !digestPattern.test(item.sha256) ||
        seen.has(item.path))
      reject("Trusted fixture inputs need unique checkout-relative paths and SHA-256 pins.");
    seen.add(item.path);
    const fullPath = path.resolve(root, item.path);
    if (!within(root, fullPath) || await realpath(fullPath) !== fullPath)
      reject("Trusted fixture inputs must be real files inside the project.");
    const bytes = await pinnedFile(fullPath, inputFileLimit, `project input ${item.path}`);
    total += bytes.length;
    if (total > inputBatchLimit || hash(bytes) !== item.sha256)
      reject("Trusted fixture project input changed or exceeds its batch limit.");
    inputs.push(Object.freeze({ path: item.path, sha256: item.sha256 }));
  }
  return Object.freeze(inputs);
}

function descriptorShape(value) {
  if (!object(value) || !keysAre(value, [
    "version", "executable", "sha256", "args", "cleanup", "verifyCleanup", "env", "projectInputs",
    "evidenceSeal",
  ]) || value.version !== 1)
    reject("Use the strict version 1 trusted fixture descriptor schema.");
  let evidenceSeal;
  if (value.evidenceSeal !== undefined) {
    if (!object(value.evidenceSeal) || !keysAre(value.evidenceSeal, ["manifest", "archiveRoot"]) ||
        typeof value.evidenceSeal.manifest !== "string" ||
        !path.isAbsolute(value.evidenceSeal.manifest) || value.evidenceSeal.manifest.includes("\0") ||
        path.resolve(value.evidenceSeal.manifest) !== value.evidenceSeal.manifest)
      reject("Trusted fixture evidenceSeal needs an absolute canonical manifest path.");
    if (value.evidenceSeal.archiveRoot !== undefined &&
        (typeof value.evidenceSeal.archiveRoot !== "string" ||
         !path.isAbsolute(value.evidenceSeal.archiveRoot) ||
         value.evidenceSeal.archiveRoot.includes("\0") ||
         path.resolve(value.evidenceSeal.archiveRoot) !== value.evidenceSeal.archiveRoot))
      reject("Trusted fixture archiveRoot must be an absolute canonical path.");
    evidenceSeal = Object.freeze({ manifest: value.evidenceSeal.manifest,
      ...(value.evidenceSeal.archiveRoot !== undefined && { archiveRoot: value.evidenceSeal.archiveRoot }) });
  }
  const primary = action({ executable: value.executable, sha256: value.sha256, args: value.args });
  const cleanup = action(value.cleanup);
  const verifyCleanup = action(value.verifyCleanup);
  return { primary, cleanup, verifyCleanup, env: environment(value.env), projectInputs: value.projectInputs,
    evidenceSeal };
}

export async function resolveTrustedFixture({ trustedFixtures, fixtureId: id, projectRoot }) {
  if (!object(trustedFixtures) || Object.keys(trustedFixtures).length > 32 ||
      typeof id !== "string" || !fixtureId.test(id) || !Object.hasOwn(trustedFixtures, id) ||
      typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))
    reject("An exact approved fixture ID and absolute project root are required.");
  const grant = trustedFixtures[id];
  if (!object(grant) || !keysAre(grant, ["descriptor", "sha256"]) ||
      typeof grant.descriptor !== "string" || !path.isAbsolute(grant.descriptor) ||
      grant.descriptor.includes("\0") || !digestPattern.test(grant.sha256))
    reject("The approved fixture grant must pin an absolute descriptor path and SHA-256.");
  const root = await realpath(projectRoot);
  if (!(await lstat(root)).isDirectory()) reject("The trusted fixture project root must be a directory.");
  const descriptorPath = path.resolve(grant.descriptor);
  if (descriptorPath !== grant.descriptor || within(root, descriptorPath) ||
      await realpath(descriptorPath) !== descriptorPath)
    reject("The trusted fixture descriptor must be a canonical absolute operator file outside the project.");
  const descriptorBytes = await pinnedFile(descriptorPath, descriptorLimit, "descriptor");
  const descriptorSha256 = hash(descriptorBytes);
  if (descriptorSha256 !== grant.sha256)
    reject("The trusted fixture descriptor no longer matches its operator-approved hash.");
  const parsed = duplicateCheckedJson(descriptorBytes);
  const shape = descriptorShape(parsed);
  if (shape.evidenceSeal) {
    const { manifest, archiveRoot } = shape.evidenceSeal;
    if (within(root, manifest) || await realpath(manifest) !== manifest)
      reject("Trusted fixture evidence seal manifest must be canonical and outside the project.");
    if (archiveRoot !== undefined) {
      let archiveInfo;
      try {
        if (await realpath(archiveRoot) === archiveRoot) archiveInfo = await lstat(archiveRoot);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      if (archiveRoot === root || within(root, archiveRoot) || within(archiveRoot, root) ||
          !archiveInfo?.isDirectory())
        reject("Trusted fixture archive root must be a disjoint canonical directory without aliases.");
    }
  }
  const primary = shape.primary;
  const verifiedInputs = await projectInputs(shape.projectInputs, root);
  const descriptor = Object.freeze({ version: 1, executable: primary.executable, sha256: primary.sha256,
    args: primary.args, cleanup: shape.cleanup, verifyCleanup: shape.verifyCleanup, env: shape.env,
    projectInputs: verifiedInputs, ...(shape.evidenceSeal && { evidenceSeal: shape.evidenceSeal }) });
  for (const [role, step] of [
    ["primary executable", descriptor],
    ["cleanup executable", descriptor.cleanup],
    ["verification executable", descriptor.verifyCleanup],
  ]) {
    const bytes = await pinnedFile(step.executable, executableLimit, role, true);
    if (hash(bytes) !== step.sha256)
      reject("A trusted fixture executable does not match its pinned SHA-256 bytes.");
  }
  return Object.freeze({ descriptor, descriptorSha256, projectInputs: verifiedInputs });
}
