import { execFile } from "node:child_process";
// allow: SIZE_OK — The existing tracker state machine remains one persisted-contract owner in this scoped port.
import { promisify, isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, lstat, mkdir, mkdtemp, open, chmod, access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { release, version } from "node:os";
import { createRunContext } from "./harness-observation.mjs";
import { verifyEvidenceSeal } from "./evidence-seal.mjs";
import { resolveTrustedFixture } from "./trusted-fixtures.mjs";

const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ignored = new Set([".git", ".beads", "node_modules"]);
export const WORK_INTERFACE = Object.freeze({
  noteKinds: Object.freeze(["finding", "question", "decision", "constraint"]),
  recoveryOperations: Object.freeze(["refresh-first-case", "cancel-expansion"]),
  recoveryContractVersion: 3,
  reviewMaxCharacters: 4000,
  measurementMaxMs: 120000,
  functionalMaxMs: 600000,
});
export const WORK_HISTORY_LIMITS = Object.freeze({
  readByteLimit: 2 * 1024 * 1024,
  packetNoteLimit: 12,
  packetTextCharacters: 1000,
  packetSourceCharacters: 512,
  retrieval: "Beads 1.3.4 comments returns the whole retained history; its CLI has no pagination.",
  recovery: "If history exceeds readByteLimit, export it outside this adapter with bd --sandbox comments ISSUE --json to a private file. Retain the original bead and history, inspect the export, then create replacement work with a bounded summary citing the original issue. Reconcile dependencies and inspect/stop any active native owner before explicit recovery; do not delete history or automatically redispatch.",
});

export class WorkError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "WorkError"; this.code = code; }
}



function workData(issue) {
  const work = issue.metadata?.qrclipWork;
  if (work?.version !== 1 || !Array.isArray(work.paths))
    throw new WorkError("unmanaged-work", "This issue has no implement-standard work contract.");
  return work;
}

function receiptPacket(receipt) {
  if (!receipt) return undefined;
  const packet = { truncated: {} };
  for (const [field, limit] of Object.entries({ attemptId: 80, taskId: 160, childSession: 160,
    error: 1000, toolCallId: 256, nativeStatus: 80, resultSha256: 64, outcome: 80, recordedAt: 80 })) {
    const value = receipt[field];
    packet[field] = typeof value === "string" ? value.slice(0, limit) : null;
    packet.truncated[field] = typeof value === "string" && value.length > limit;
  }
  return packet;
}

export function workMarker(id, attempt) {
  return `[QRCLIP_WORK ${id} ${attempt}]`;
}

export function parseWorkMarker(text) {
  const match = /^\[QRCLIP_WORK ([a-zA-Z0-9.-]+) ([a-f0-9-]{36})\](?:\r?\n|$)/.exec(text);
  return match ? { id: match[1], attempt: match[2] } : null;
}

export function createWorkTracker({ cwd, actor, binary = "bd", beforeCall, env,
  allowWslEvidenceChecks = false, trustedFixtures = {} }) {
  const root = path.resolve(cwd);
  if (!actor || actor.length > 160) throw new WorkError("actor", "A bounded session identity is required.");
  const actorFor = attempt => `omo:${attempt}`;
  const artifactRoot = path.join(".beads", "retired-artifacts");
  if (!trustedFixtures || typeof trustedFixtures !== "object" || Array.isArray(trustedFixtures) ||
      Object.keys(trustedFixtures).length > 32)
    throw new WorkError("trusted-fixture", "trustedFixtures must be an object of at most 32 exact fixture grants.");
  const relative = file => {
    const full = path.resolve(root, file);
    if (full === root || !full.startsWith(root + path.sep))
      throw new WorkError("scope", "Work inputs must be paths inside this checkout.");
    return path.relative(root, full);
  };
  async function bd(args, commandActor = actor) {
    try {
      const commandArgs = ["--sandbox", "--actor", commandActor, ...args, "--json"];
      await beforeCall?.({ args: commandArgs });
      const { stdout } = await execute(binary, commandArgs, {
        cwd: root, env: { ...(env ?? process.env), GIT_MASTER: "1" },
        timeout: 15000, maxBuffer: WORK_HISTORY_LIMITS.readByteLimit,
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (args[0] === "comments" && args[1] !== "add" && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new WorkError("history-limit",
          `Retained comment output exceeds ${WORK_HISTORY_LIMITS.readByteLimit} bytes. ${WORK_HISTORY_LIMITS.recovery}`,
          { cause: error });
      throw error;
    }
  }
  async function issue(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9.-]+$/.test(id))
      throw new WorkError("issue", "Invalid work identifier.");
    const [value] = await bd(["show", id]);
    if (!value) throw new WorkError("issue", "Work item was not found.");
    if (value.id !== id) throw new WorkError("issue", "Beads resolved a different full work identifier.");
    return value;
  }
  async function fingerprint(paths, { includeIgnored = false } = {}) {
    const files = {};
    let bytes = 0;
    let entries = 0;
    async function visit(file) {
      const name = relative(file);
      if (++entries > 2000) throw new WorkError("scope", "Narrow this work item's source scope.");
      // lstat on the leaf alone would follow a symlink in an ancestor.
      let ancestor = root;
      for (const part of name.split(path.sep).slice(0, -1)) {
        ancestor = path.join(ancestor, part);
        try {
          if ((await lstat(ancestor)).isSymbolicLink())
            throw new WorkError("scope", "Source scopes cannot traverse symbolic links.");
        } catch (error) {
          if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
          break;
        }
      }
      let stat;
      try { stat = await lstat(path.join(root, name)); }
      catch (error) {
        if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
        files[name] = null;
        return;
      }
      if (stat.isSymbolicLink()) throw new WorkError("scope", "Source scopes cannot contain symbolic links.");
      if (stat.isDirectory()) {
        files[name + "/"] = "directory";
        for (const child of (await readdir(path.join(root, name))).sort())
          if (includeIgnored || !ignored.has(child)) await visit(path.join(name, child));
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (Object.keys(files).length >= 1000 || bytes > 16 * 1024 * 1024)
          throw new WorkError("scope", "Narrow this work item's source scope.");
        files[name] = hash(await readFile(path.join(root, name)));
      }
    }
    for (const file of paths) await visit(file);
    return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  }
  async function fresh(proof) {
    if (!proof?.sources || !proof.receipt) return false;
    try {
      const evidence = proof.retainedEvidence === undefined ? [] : parseRetainedEvidence(proof.retainedEvidence);
      const inherited = proof.inheritedRetainedEvidence === undefined
        ? [] : parseRetainedEvidence(proof.inheritedRetainedEvidence);
      const allEvidence = mergeRetainedEvidence(inherited, evidence);
      const expected = { ...proof.sources };
      const evidencePaths = new Set();
      for (const entry of allEvidence) {
        if (!proof.paths.includes(entry.path) || expected[entry.path] !== entry.sha256) return false;
        delete expected[entry.path];
        evidencePaths.add(entry.path);
      }
      const observed = await fingerprint(proof.paths.filter(file => !evidencePaths.has(file)));
      // A normal source directory can also cover one of the explicit files.
      for (const file of evidencePaths) delete observed[file];
      if (!isDeepStrictEqual(observed, expected)) return false;
      const receipt = await readFile(path.join(root, relative(proof.receipt.path)));
      if (hash(receipt) !== proof.receipt.sha256) return false;
      if (evidence.length) {
        const observation = JSON.parse(receipt);
        if (observation.status !== "complete" || observation.primary?.kind !== "retained-evidence" ||
            observation.commands?.length !== 0 ||
            !observation.events?.some(event => event.type === "phase" &&
              event.name === "retained-evidence" && event.details?.evidenceSha256 === hash(JSON.stringify(evidence))))
          return false;
      }
      if (allEvidence.length) await verifyRetainedEvidence(allEvidence, performance.now() + 5000);
      return true;
    }
    catch (error) {
      if (!(error instanceof Error) || !["ENOENT", "retained-evidence"].includes(error.code)) throw error;
      return false;
    }
  }
  function parseRetainedEvidence(input) {
    if (!Array.isArray(input) || !input.length || input.length > 8)
      throw new WorkError("retained-evidence", "Supply one to eight retained file hashes.");
    const paths = new Set();
    return input.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          Object.keys(item).some(key => !["path", "sha256", "completeManifest"].includes(key)) ||
          typeof item.path !== "string" || item.path.length > 512 ||
          item.path.includes("\0") || item.path !== relative(item.path) ||
          typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
          (item.completeManifest !== undefined && item.completeManifest !== true) ||
          paths.has(item.path))
        throw new WorkError("retained-evidence", "Use distinct checkout-relative paths and SHA-256 hashes, with optional completeManifest: true.");
      paths.add(item.path);
      return { path: item.path, sha256: item.sha256, ...(item.completeManifest && { completeManifest: true }) };
    });
  }
  function mergeRetainedEvidence(...groups) {
    const files = new Map();
    for (const group of groups) {
      for (const entry of group) {
        const previous = files.get(entry.path);
        if (previous && previous.sha256 !== entry.sha256)
          throw new WorkError("retained-evidence", "Retained evidence inputs disagree: " + entry.path);
        if (!previous || entry.completeManifest) files.set(entry.path, entry);
        if (files.size > 8)
          throw new WorkError("retained-evidence", "A check and its prerequisites can cover at most eight retained evidence files.");
      }
    }
    return [...files.values()];
  }
  async function verifyRetainedEvidence(entries, deadline) {
    let remaining = 32 * 1024 * 1024;
    for (const entry of entries) {
      const full = path.join(root, entry.path);
      const reject = () => new WorkError("retained-evidence", `Invalid, changed, or oversized retained evidence: ${entry.path}`);
      try {
        if (await realpath(full) !== full || !(await lstat(full)).isFile()) throw reject();
        const file = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
          const before = await file.stat({ bigint: true });
          const opened = await realpath(`/proc/self/fd/${file.fd}`);
          if (opened !== full || !before.isFile() || before.nlink !== 1n ||
              before.size > BigInt(entry.completeManifest ? Math.min(remaining, 64 * 1024) : remaining)) throw reject();
          const digest = createHash("sha256");
          const buffer = Buffer.alloc(Math.min(64 * 1024, Number(before.size) + 1));
          const manifest = entry.completeManifest ? [] : undefined;
          let count = 0;
          for (;;) {
            if (performance.now() >= deadline) throw reject();
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - count + 1), count);
            if (bytesRead === 0) break;
            count += bytesRead;
            if (count > before.size) throw reject();
            const chunk = buffer.subarray(0, bytesRead);
            digest.update(chunk);
            if (manifest) manifest.push(Buffer.from(chunk));
          }
          const after = await lstat(full, { bigint: true });
          if (count !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
              after.size !== before.size || after.nlink !== 1n ||
              after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
              digest.digest("hex") !== entry.sha256 ||
              (manifest && JSON.parse(Buffer.concat(manifest).toString("utf8"))?.status !== "complete")) throw reject();
          remaining -= count;
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!(error instanceof Error) || error.code === "retained-evidence") throw error;
        throw new WorkError("retained-evidence", `Cannot verify retained evidence: ${entry.path}`, { cause: error });
      }
    }
  }
  async function fixtureContract(fixture) {
    if (fixture === undefined) return undefined;
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture))
      throw new WorkError("input", "Provide a structured fixture contract.");
    if (fixture.stage === "first-case" && typeof fixture.visual === "boolean" &&
        Object.keys(fixture).every(key => ["stage", "visual"].includes(key)))
      return { stage: "first-case", visual: fixture.visual };
    if (fixture.stage === "expansion" && typeof fixture.firstCase === "string" &&
        Object.keys(fixture).every(key => ["stage", "firstCase"].includes(key))) {
      const first = await issue(fixture.firstCase);
      if (workData(first).fixture?.stage === "first-case")
        return { stage: "expansion", firstCase: first.id };
    }
    throw new WorkError("input", "Use first-case with visual, or expansion referencing a first-case work item.");
  }
  function labelsInput(labels) {
    if (labels === undefined) return undefined;
    if (!Array.isArray(labels) || labels.length > 32 ||
        labels.some(label => typeof label !== "string" || !/^[a-z0-9][a-z0-9:-]{0,63}$/.test(label)))
      throw new WorkError("input", "Use at most 32 bounded labels.");
    return [...new Set(labels)].sort();
  }
  async function firstCaseEvidence(descriptor, fixture, run) {
    const fail = message => { throw new WorkError("fixture-evidence", message); };
    if (!descriptor || typeof descriptor.report !== "string" ||
        !Array.isArray(descriptor.visualEvidence) || descriptor.visualEvidence.length > 16 ||
        descriptor.visualEvidence.some(file => typeof file !== "string" || !file.endsWith(".png")) ||
        (fixture.visual && !descriptor.visualEvidence.length))
      fail("A first case requires its terminal report and PNG evidence when visual.");
    const reportPath = relative(descriptor.report);
    await fingerprint([reportPath]);
    const reportBytes = await readFile(path.join(root, reportPath));
    const report = JSON.parse(reportBytes);
    const bound = value => value?.nonce === run.nonce && value?.id === run.id &&
      value?.attempt === run.attempt;
    if (!bound(report.workCheck))
      fail("The first-case report must bind to this executed work check.");
    if (report.passed !== true || !Array.isArray(report.cleanup) || !report.cleanup.length ||
        report.cleanup.some(item => item?.passed !== true) ||
        !Array.isArray(report.publicationErrors) || report.publicationErrors.length ||
        report.observation?.ok !== true || typeof report.observation.manifestPath !== "string")
      fail("The first-case whole-run report, cleanup and publication must pass.");
    const recordedSources = report.source?.files;
    if (!recordedSources || typeof recordedSources !== "object" || Array.isArray(recordedSources) ||
        !Object.keys(recordedSources).length || Object.values(recordedSources).some(value =>
          typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
      fail("The first-case report must identify its actual source hashes.");
    const manifestPath = relative(report.observation.manifestPath);
    if (descriptor.manifest !== undefined && manifestPath !== relative(descriptor.manifest))
      fail("The executed report must identify the explicitly fresh observation manifest destination.");
    if (descriptor.observationDirectory !== undefined &&
        !manifestPath.startsWith(relative(descriptor.observationDirectory) + path.sep))
      fail("The executed observation manifest must be inside its declared fresh output directory.");
    const visuals = descriptor.visualEvidence.map(relative);
    const artifacts = [...new Set([reportPath, manifestPath, ...visuals])].sort();
    const paths = [...new Set([...Object.keys(recordedSources).map(relative), ...artifacts])].sort();
    const sources = await fingerprint(paths);
    for (const file of artifacts) {
      const stat = await lstat(path.join(root, file));
      if (!stat.isFile() || stat.nlink !== 1)
        fail("First-case evidence must use regular files without hard-link aliases.");
    }
    sources[reportPath] = hash(reportBytes);
    for (const [file, expected] of Object.entries(recordedSources))
      if (sources[relative(file)] !== expected) fail("First-case source evidence is stale: " + file);
    const manifestBytes = await readFile(path.join(root, manifestPath));
    const manifest = JSON.parse(manifestBytes);
    sources[manifestPath] = hash(manifestBytes);
    if (!bound(manifest.workCheck))
      fail("The first-case observation must bind to this executed work check.");
    if (manifest.status !== "complete" || manifest.primary?.ok !== true ||
        !manifest.failures || typeof manifest.failures !== "object" ||
        Array.isArray(manifest.failures) ||
        ["primary", "diagnostic", "termination", "cleanup", "publication"].some(key =>
          !Array.isArray(manifest.failures[key]) || manifest.failures[key].length))
      fail("The first-case observation must be terminal and successful.");
    for (const file of visuals) {
      const bytes = await readFile(path.join(root, file));
      if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        fail("First-case visual evidence is not a PNG: " + file);
      sources[file] = hash(bytes);
    }
    if (JSON.stringify(sources) !== JSON.stringify(await fingerprint(paths)))
      fail("First-case evidence changed during validation.");
    return { paths, sources, firstCase: { report: reportPath, manifest: manifestPath,
      visualEvidence: visuals, artifacts: Object.fromEntries(artifacts.map(file => [file, sources[file]])) } };
  }
  async function milestoneFresh(proof) {
    if (!proof?.firstCase || !proof.fixtureReview?.text || !proof.receipt) return false;
    const artifacts = proof.firstCase.artifacts;
    if (!artifacts || !Object.keys(artifacts).length) return false;
    try {
      return hash(await readFile(path.join(root, relative(proof.receipt.path)))) === proof.receipt.sha256 &&
        isDeepStrictEqual(await fingerprint(Object.keys(artifacts)), artifacts);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
      return false;
    }
  }
  async function verifyArtifactArchives(work) {
    const fail = () => { throw new WorkError("artifact-preservation",
      "Historical artifact mappings and read-only retained bytes must be intact before work can execute."); };
    if ((work.retiredArtifacts !== undefined && !Array.isArray(work.retiredArtifacts)) ||
        (work.artifactArchives !== undefined && !Array.isArray(work.artifactArchives))) fail();
    const protectedPaths = new Set(work.retiredArtifacts || []);
    const covered = new Set();
    for (const archive of work.artifactArchives || []) {
      if (!archive?.artifacts || typeof archive.artifacts !== "object" ||
          Array.isArray(archive.artifacts) || !Object.keys(archive.artifacts).length ||
          !archive.receipt || archive.artifacts[archive.receipt.path]?.sha256 !== archive.receipt.sha256)
        fail();
      const expected = {};
      const originals = {};
      for (const [original, saved] of Object.entries(archive.artifacts)) {
        if (typeof saved?.path !== "string" || typeof saved.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(saved.sha256)) fail();
        const file = relative(saved.path);
        if (!file.startsWith(artifactRoot + path.sep) || path.basename(file) !== saved.sha256) fail();
        expected[file] = saved.sha256;
        originals[relative(original)] = saved.sha256;
        covered.add(relative(original));
        protectedPaths.add(file);
      }
      const observed = await fingerprint(Object.keys(expected));
      const ordered = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
      if (JSON.stringify(observed) !== JSON.stringify(ordered)) fail();
      const originalBytes = await fingerprint(Object.keys(originals));
      const orderedOriginals = Object.fromEntries(Object.entries(originals).sort(([a], [b]) => a.localeCompare(b)));
      if (JSON.stringify(originalBytes) !== JSON.stringify(orderedOriginals)) fail();
      for (const file of Object.keys(expected))
        if ((await lstat(path.join(root, file))).mode & 0o222) fail();
    }
    for (const file of work.retiredArtifacts || [])
      if (!covered.has(relative(file))) fail();
    return [...protectedPaths];
  }
  async function captureTrustedEvidence(work, upstream, extraPaths = []) {
    const evidencePaths = new Set([
      ...(work.accepted?.paths || []),
      ...(work.accepted?.receipt ? [work.accepted.receipt.path] : []),
      ...Object.keys(work.accepted?.sources || {}),
      ...Object.keys(work.accepted?.firstCase?.artifacts || {}),
      ...(work.retiredArtifacts || []),
      ...upstream.protectedArtifacts,
      ...extraPaths,
    ]);
    const baseline = {};
    for (const file of [...evidencePaths].sort()) {
      const full = path.join(root, relative(file));
      try {
        const stat = await lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            stat.size > 32 * 1024 * 1024)
          throw new WorkError("trusted-fixture-evidence",
            "Accepted evidence must be bounded regular files without hard-link aliases.");
        baseline[file] = hash(await readFile(full));
      } catch (error) {
        if (error instanceof WorkError) throw error;
        if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
        baseline[file] = null;
      }
    }
    return baseline;
  }
  async function trustedEvidenceFiles(work, upstream, extraPaths, projectInputs, { external = false } = {}) {
    const files = external ? Object.create(null) : await captureTrustedEvidence(work, upstream, extraPaths);
    const add = (file, digest) => {
      if (typeof file !== "string" || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
        throw new WorkError("trusted-fixture-seal", "Authoritative evidence hashes are malformed.");
      if (Object.hasOwn(files, file) && files[file] !== digest)
        throw new WorkError("trusted-fixture-seal", "Authoritative evidence hashes conflict.");
      files[file] = digest;
    };
    const addReceipt = receipt => { if (receipt) add(receipt.path, receipt.sha256); };
    const addArtifacts = artifacts => {
      for (const [file, item] of Object.entries(artifacts || {}))
        add(file, typeof item === "string" ? item : item?.sha256);
    };
    const acceptedProofs = [work.accepted, ...upstream.acceptedProofs].filter(Boolean);
    if (external) {
      for (const proof of acceptedProofs) {
        addReceipt(proof.receipt);
        addArtifacts(proof.firstCase?.artifacts);
        for (const item of [...(proof.retainedEvidence || []), ...(proof.inheritedRetainedEvidence || [])])
          add(item.path, item.sha256);
      }
      for (const archive of [...(work.artifactArchives || []), ...upstream.artifactArchives]) {
        addReceipt(archive.receipt);
        for (const [original, saved] of Object.entries(archive.artifacts || {})) {
          add(original, saved.sha256);
          add(saved.path, saved.sha256);
        }
      }
      for (const file of [...upstream.protectedArtifacts, ...(work.retiredArtifacts || [])])
        if (!Object.hasOwn(files, file))
          throw new WorkError("trusted-fixture-seal",
            `Protected evidence has no accepted Beads digest: ${file}`);
    }
    for (const proof of acceptedProofs) {
      for (const [file, digest] of Object.entries(proof.sources || {})) {
        if (!/^[a-f0-9]{64}$/.test(digest)) continue;
        add(file, digest);
      }
      for (const item of [...(proof.retainedEvidence || []), ...(proof.inheritedRetainedEvidence || [])])
        add(item.path, item.sha256);
      addArtifacts(proof.firstCase?.artifacts);
    }
    for (const input of external ? [] : projectInputs) {
      if (files[input.path] !== undefined && files[input.path] !== input.sha256)
        throw new WorkError("trusted-fixture-seal",
          "Pinned fixture inputs conflict with authoritative evidence hashes.");
    }
    return files;
  }
  async function prerequisites(value, { admission = false } = {}) {
    const sources = {};
    const paths = [];
    const receipts = {};
    const protectedArtifacts = [];
    const artifactArchives = [];
    const acceptedProofs = [];
    let retainedEvidence = [];
    const fixture = workData(value).fixture;
    if (fixture?.stage === "expansion" && !(value.dependencies || []).some(dependency =>
      dependency.dependency_type === "blocks" && dependency.id === fixture.firstCase))
      throw new WorkError("blocked", "Fixture expansion is missing its first-case blocking dependency.");
    for (const dependency of value.dependencies || []) {
      if (dependency.dependency_type !== "blocks") continue;
      const parent = await issue(dependency.id);
      const proof = workData(parent).accepted;
      const firstCase = fixture?.stage === "expansion" && fixture.firstCase === parent.id;
      const valid = firstCase
        ? workData(parent).fixture?.stage === "first-case" && await milestoneFresh(proof) &&
          (!admission || await fresh(proof))
        : await fresh(proof);
      if (parent.status !== "closed" || !valid)
        throw new WorkError("blocked", `Prerequisite ${parent.id} is open or its evidence is stale.`);
      Object.assign(sources, proof.sources || {});
      // These files are rechecked by fresh() against their dedicated budget.
      // Older writers can see them as ordinary inputs and will fail closed
      // if their smaller fingerprint budget cannot cover them.
      const inherited = mergeRetainedEvidence(proof.inheritedRetainedEvidence ?? [], proof.retainedEvidence ?? []);
      retainedEvidence = mergeRetainedEvidence(retainedEvidence, inherited);
      const evidencePaths = new Set(inherited.map(entry => entry.path));
      paths.push(...proof.paths.filter(file => !evidencePaths.has(file)));
      receipts[parent.id] = proof.receipt.sha256;
      artifactArchives.push(...(workData(parent).artifactArchives || []));
      acceptedProofs.push(proof);
      protectedArtifacts.push(proof.receipt.path, ...evidencePaths, ...Object.keys(proof.firstCase?.artifacts || {}),
        ...await verifyArtifactArchives(workData(parent)));
    }
    return { sources, paths, receipts, retainedEvidence, protectedArtifacts: [...new Set(protectedArtifacts)],
      artifactArchives, acceptedProofs };
  }
  async function update(id, args, commandActor = actor) {
    const [value] = await bd(["update", id, ...args], commandActor);
    return value;
  }
  async function owned(id, attempt) {
    const value = await issue(id);
    const work = workData(value);
    if (work.attempt?.id !== attempt || value.assignee !== actorFor(attempt))
      throw new WorkError("ownership", "The work attempt is no longer owned.");
    return { value, work };
  }
  async function packet(id) {
    const value = await issue(id);
    const work = workData(value);
    const comments = await bd(["comments", id]);
    const notes = comments.slice(-WORK_HISTORY_LIMITS.packetNoteLimit).map(note => {
      const raw = String(note.text ?? note.body ?? "");
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Native Beads comments may be ordinary text, rather than adapter JSON.
        parsed = null;
      }
      const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      const text = typeof envelope.text === "string" ? envelope.text :
        typeof envelope.reason === "string" ? envelope.reason : raw;
      const values = {
        kind: envelope.kind || "comment", text, session: envelope.session, source: envelope.source,
        observedAt: envelope.observedAt, recordedAt: envelope.recordedAt,
        author: note.author, createdAt: note.created_at,
      };
      const limits = { kind: 32, text: WORK_HISTORY_LIMITS.packetTextCharacters, session: 160,
        source: WORK_HISTORY_LIMITS.packetSourceCharacters, observedAt: 80, recordedAt: 80,
        author: 160, createdAt: 80 };
      const bounded = { originalTextLength: text.length, truncated: {} };
      for (const [field, limit] of Object.entries(limits)) {
        const value = values[field];
        bounded[field] = typeof value === "string" ? value.slice(0, limit) : null;
        bounded.truncated[field] = typeof value === "string" && value.length > limit;
      }
      if (envelope.kind === "recovery" && envelope.previous?.attempt) {
        bounded.previousAttempt = {};
        bounded.truncated.previousAttempt = false;
        for (const field of ["id", "coordinator", "name", "mode", "preparedAt"]) {
          const value = envelope.previous.attempt[field];
          bounded.previousAttempt[field] = typeof value === "string" ? value.slice(0, 160) : null;
          bounded.truncated.previousAttempt ||= typeof value === "string" && value.length > 160;
        }
      }
      if (envelope.kind === "recovery")
        bounded.previousDispatch = receiptPacket(envelope.previousDispatch);
      return bounded;
    });
    return {
      id, title: value.title, objective: value.description,
      acceptance: value.acceptance_criteria || "", status: value.status,
      paths: work.paths, attempt: work.attempt ? {
        id: work.attempt.id, coordinator: work.attempt.coordinator, mode: work.attempt.mode,
        name: work.attempt.name, preparedAt: work.attempt.preparedAt,
      } : undefined,
      dispatch: value.metadata?.qrclipDispatch?.attemptId === work.attempt?.id
        ? receiptPacket(value.metadata.qrclipDispatch) : undefined,
      dependencies: (value.dependencies || []).map(d => ({ id: d.id, status: d.status, type: d.dependency_type })),
      labels: value.labels || [], fixture: work.fixture, cancelled: work.cancelled,
      notes, omittedNotes: Math.max(0, comments.length - notes.length),
      history: { readByteLimit: WORK_HISTORY_LIMITS.readByteLimit, retainedNotes: comments.length,
        packetNoteLimit: WORK_HISTORY_LIMITS.packetNoteLimit },
    };
  }
  return {
    issue, packet,
    limits: () => ({ ...WORK_HISTORY_LIMITS, fixtureGateVersion: 1,
      recoveryContractVersion: WORK_INTERFACE.recoveryContractVersion, deadlineContractVersion: 1,
      wslFixtureExceptionVersion: 1, retainedEvidenceCheckVersion: 1,
      trustedFixtureCheckVersion: 1, evidenceSealVersion: 1, externalEvidenceArchiveVersion: 1 }),
    async create({ title, objective, paths = [], blockedBy = [], acceptance = "",
      fixture, parent, labels = [], type = "task" }) {
      if (!title || title.length > 160 || !objective || objective.length > 8000)
        throw new WorkError("input", "Provide a bounded title and objective.");
      if (!Array.isArray(paths) || paths.length > 32 || !Array.isArray(blockedBy) ||
          blockedBy.length > 32 || blockedBy.some(id => !/^[a-zA-Z0-9.-]+$/.test(id)) ||
          typeof acceptance !== "string" || acceptance.length > 8000)
        throw new WorkError("input", "Use at most 32 paths/dependencies and bounded acceptance criteria.");
      const scope = [...new Set(paths.map(relative))].sort();
      for (const dependency of new Set(blockedBy)) await issue(dependency);
      const contract = await fixtureContract(fixture);
      const tags = labelsInput(labels);
      if (!["task", "epic"].includes(type)) throw new WorkError("input", "Use task or epic.");
      if (parent !== undefined) await issue(parent);
      const dependencies = [...new Set([...blockedBy,
        ...(contract?.stage === "expansion" ? [contract.firstCase] : [])])];
      const value = await bd(["create", title, "--description", objective, "--labels",
        [...new Set(["omo-work", ...tags])].join(","),
        "--acceptance", acceptance,
        "--type", type, ...(parent ? ["--parent", parent] : []),
        "--metadata", JSON.stringify({ qrclipWork: { version: 1, paths: scope, fixture: contract } }),
        ...(dependencies.length ? ["--deps", dependencies.join(",")] : [])]);
      return { id: value.id, title: value.title };
    },
    async edit(id, { title, objective, acceptance, fixture, parent, labels }) {
      const value = await issue(id);
      const work = workData(value);
      const contractEdit = [title, objective, acceptance, fixture].some(value => value !== undefined);
      if (contractEdit && (parent !== undefined || labels !== undefined))
        throw new WorkError("input", "Edit the guarded work contract separately from labels or hierarchy.");
      if (contractEdit && (value.status !== "open" || value.assignee))
        throw new WorkError("state", "Recover active work explicitly before editing its contract.");
      if (contractEdit && (work.refresh || work.accepted))
        throw new WorkError("state", "Reconcile an accepted or interrupted generation before editing its contract.");
      if (!contractEdit && value.status === "blocked")
        throw new WorkError("state", "Do not reorganize a work item during its exclusive transition.");
      const args = [];
      let contract;
      for (const [name, text, cap] of [["title", title, 160], ["description", objective, 8000],
        ["acceptance", acceptance, 8000]]) {
        if (text === undefined) continue;
        if (typeof text !== "string" || !text || text.length > cap)
          throw new WorkError("input", `Invalid ${name}.`);
        args.push("--" + name, text);
      }
      if (fixture !== undefined) {
        contract = await fixtureContract(fixture);
        if (contract.stage === "expansion")
          throw new WorkError("input", "Create a linked expansion item rather than replacing its admission gate.");
      }
      if (parent !== undefined) {
        if (parent === id) throw new WorkError("input", "Work cannot parent itself.");
        await issue(parent);
        args.push("--parent", parent);
      }
      if (labels !== undefined) args.push("--set-labels", labelsInput(labels).join(","));
      if (!args.length && !contract) throw new WorkError("input", "Provide a contract or organization field to edit.");
      // Beads guards cover work fields, not parent/label relationships. An
      // organization-only update never writes ownership or acceptance metadata.
      if (!contractEdit) await update(id, args);
      else {
        const snapshot = current => JSON.stringify({ work: workData(current),
          dispatch: current.metadata?.qrclipDispatch || null, title: current.title,
          description: current.description, acceptance: current.acceptance_criteria || "" });
        const prior = snapshot(value);
        const editing = `omo:edit:${randomUUID()}`;
        await update(id, ["--if-status", "open", "--if-assignee", "",
          "--assignee", editing, "--status", "blocked"], editing);
        let protectedState;
        try {
          const latest = await issue(id);
          if (latest.assignee !== editing || latest.status !== "blocked")
            throw new WorkError("ownership", "The contract edit transition is no longer owned.");
          protectedState = snapshot(latest);
          if (protectedState !== prior)
            throw new WorkError("stale-input", "The protected contract changed before the edit reservation.");
          await update(id, ["--if-assignee", editing, "--if-status", "blocked", ...args,
            ...(contract ? ["--metadata", JSON.stringify({ qrclipWork: { ...workData(latest), fixture: contract } })] : []),
            "--assignee", "", "--status", "open"], editing);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          try {
            const latest = await issue(id);
            if (latest.assignee === editing && latest.status === "blocked" && protectedState === snapshot(latest))
              await update(id, ["--if-assignee", editing, "--if-status", "blocked",
                "--assignee", "", "--status", "open"], editing);
          } catch (releaseError) {
            throw new AggregateError([error, releaseError], "Contract edit failed and its owner could not be safely released.");
          }
          throw error;
        }
      }
      return packet(id);
    },
    async recover(id, { assignee, status, reason, confirmedStopped, operation }) {
      const value = await issue(id);
      const work = workData(value);
      // null is the explicit caller observation for an unassigned cancellation.
      // Beads omits assignee in show output and accepts "" in its CAS flag.
      const observedUnassigned = operation === "cancel-expansion" && assignee === null;
      const ownerMatches = observedUnassigned
        ? value.assignee == null || value.assignee === "" : value.assignee === assignee;
      const guardedAssignee = observedUnassigned ? "" : assignee;
      if (confirmedStopped !== true || typeof reason !== "string" || !reason.trim() || reason.length > 2000 ||
          !ownerMatches || value.status !== status ||
          (operation === undefined && status === "closed") ||
          (operation !== undefined && !WORK_INTERFACE.recoveryOperations.includes(operation)))
        throw new WorkError("recovery", "Confirm the old owner stopped and supply its observed assignee/status and reason.");
      if (operation === undefined && (work.refresh || work.accepted))
        throw new WorkError("recovery", "Generic recovery cannot discard accepted proof or an interrupted refresh; inspect and explicitly resume refresh-first-case when applicable.");
      const prior = JSON.stringify({ work, dispatch: value.metadata?.qrclipDispatch || null });
      const validate = async current => {
        const currentWork = workData(current);
        switch (operation) {
          case undefined: return;
          case "refresh-first-case": {
            const initial = status === "closed" && !work.refresh &&
              assignee === actorFor(work.attempt?.id);
            const resumed = status === "blocked" && work.refresh?.version === 1 &&
              typeof work.refresh.id === "string" && /^[a-f0-9-]{36}$/.test(work.refresh.id) &&
              work.refresh.owner === assignee && work.refresh.previousStatus === "closed" &&
              work.refresh.previousAssignee === actorFor(work.attempt?.id) &&
              ["reserved", "copying", "retained", "commented"].includes(work.refresh.phase) &&
              work.refresh.receipt?.path === work.accepted?.receipt?.path &&
              work.refresh.receipt?.sha256 === work.accepted?.receipt?.sha256;
            if ((!initial && !resumed) || currentWork.fixture?.stage !== "first-case" ||
                typeof currentWork.fixture.visual !== "boolean" ||
                Object.keys(currentWork.fixture).some(key => !["stage", "visual"].includes(key)) ||
                !currentWork.attempt?.id ||
                !currentWork.accepted?.passed ||
                JSON.stringify({ ...currentWork.accepted, fixtureReview: undefined }) !==
                  JSON.stringify(currentWork.checked) ||
                !await milestoneFresh(currentWork.accepted) ||
                await fresh(currentWork.accepted))
              throw new WorkError("recovery", "Refresh requires a stale-source closed first case or its explicitly stopped in-flight marker, with intact original accepted evidence.");
            return;
          }
          case "cancel-expansion": {
            const unprepared = status === "open" && observedUnassigned &&
              !Object.hasOwn(currentWork, "attempt");
            const prepared = status === "hooked" && currentWork.attempt?.mode === "delegate" &&
              currentWork.attempt.id && assignee === actorFor(currentWork.attempt.id);
            if ((!unprepared && !prepared) || currentWork.fixture?.stage !== "expansion" ||
                typeof currentWork.fixture.firstCase !== "string" ||
                Object.keys(currentWork.fixture).some(key => !["stage", "firstCase"].includes(key)) ||
                Object.hasOwn(currentWork, "checked") || Object.hasOwn(currentWork, "accepted") ||
                currentWork.cancelled || currentWork.refresh || current.metadata?.qrclipDispatch)
              throw new WorkError("recovery", "Cancellation requires an open unassigned expansion without an attempt (observe assignee:null), or a hooked delegate; no dispatch, check or acceptance may exist.");
            await fixtureContract(currentWork.fixture);
            // Ordinary Beads closure refuses open blockers and children. Check
            // both before reserving, and again while the reservation is ours.
            const children = (await bd(["show", id, "--children"]))[id];
            if (!Array.isArray(children))
              throw new WorkError("recovery", "Cancellation could not inspect Beads children.");
            const open = [...(current.dependencies || []).filter(item =>
              item.dependency_type === "blocks"), ...children].find(item => item.status !== "closed");
            if (open)
              throw new WorkError("recovery",
                `Cancellation requires closed Beads blockers and children; ${open.id} is ${open.status}.`);
            return;
          }
          default: throw new WorkError("recovery", "Unknown recovery operation.");
        }
      };
      await validate(value);
      // Never reuse an attempt owner for the archival/reset boundary. Delayed
      // reservations can observe the same attempt/status again (ABA).
      const recovering = `omo:recovery:${randomUUID()}`;
      let activeWork = operation === "refresh-first-case" ? { ...work, refresh: {
        ...(work.refresh || { version: 1, id: randomUUID(), phase: "reserved",
          previousStatus: status, previousAssignee: assignee, receipt: work.accepted.receipt }),
        owner: recovering,
      } } : work;
      await update(id, ["--if-assignee", guardedAssignee, "--if-status", status,
        "--assignee", recovering, "--status", "blocked",
        ...(operation === "refresh-first-case" ? ["--metadata", JSON.stringify({ qrclipWork: activeWork })] : [])]);
      try {
      const protectedValue = await issue(id);
      if (protectedValue.assignee !== recovering || protectedValue.status !== "blocked" ||
          !isDeepStrictEqual({ work: workData(protectedValue), dispatch: protectedValue.metadata?.qrclipDispatch || null },
            { work: activeWork, dispatch: value.metadata?.qrclipDispatch || null }))
        throw new WorkError("recovery", "Recovery proof changed before reservation; inspect the exclusive recovery owner.");
      activeWork = workData(protectedValue);
      await validate(protectedValue);
      const publishRefresh = async fields => {
        const latest = await issue(id);
        if (latest.assignee !== recovering || latest.status !== "blocked" ||
            !isDeepStrictEqual(workData(latest), activeWork) ||
            !isDeepStrictEqual(latest.metadata?.qrclipDispatch || null, value.metadata?.qrclipDispatch || null))
          throw new WorkError("ownership", "The protected refresh generation changed before publication.");
        const next = { ...activeWork, refresh: { ...activeWork.refresh, ...fields } };
        await update(id, ["--if-assignee", recovering, "--if-status", "blocked",
          "--metadata", JSON.stringify({ qrclipWork: next })], recovering);
        activeWork = next;
      };
      let preservedArtifacts;
      if (operation === "refresh-first-case") {
        await verifyArtifactArchives(work);
        const expected = Object.fromEntries(Object.entries({
          ...work.accepted.firstCase.artifacts,
          [work.accepted.receipt.path]: work.accepted.receipt.sha256,
        }).sort(([a], [b]) => a.localeCompare(b)));
        if (JSON.stringify(await fingerprint(Object.keys(expected))) !== JSON.stringify(expected))
          throw new WorkError("artifact-preservation", "Historic artifact bytes changed before retention.");
        if (activeWork.refresh.artifacts) {
          preservedArtifacts = activeWork.refresh.artifacts;
          if (!isDeepStrictEqual(Object.keys(preservedArtifacts).sort(), Object.keys(expected).sort()) ||
              Object.entries(expected).some(([file, sha256]) => preservedArtifacts[file]?.sha256 !== sha256))
            throw new WorkError("artifact-preservation", "Interrupted refresh mappings disagree with the accepted generation.");
          await verifyArtifactArchives({ ...work,
            retiredArtifacts: [...new Set([...(work.retiredArtifacts || []), ...Object.keys(expected)])],
            artifactArchives: [...(work.artifactArchives || []),
              { receipt: work.accepted.receipt, artifacts: preservedArtifacts }] });
        } else {
        // Unique directories and exclusive, hash-named files never replace an
        // earlier archive, even when original basenames or bytes coincide.
        await fingerprint([path.join(artifactRoot, randomUUID())]);
        const store = path.join(root, artifactRoot);
        await mkdir(store, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(path.join(store, id + "-"));
        await publishRefresh({ phase: "copying", directory: relative(directory),
          directories: [...(activeWork.refresh.directories || []), relative(directory)] });
        preservedArtifacts = {};
        for (const [original, expectedHash] of Object.entries(expected)) {
          const bytes = await readFile(path.join(root, relative(original)));
          if (hash(bytes) !== expectedHash)
            throw new WorkError("artifact-preservation", "Historic artifact changed during retention: " + original);
          const retained = path.join(directory, expectedHash);
          let handle;
          try {
            handle = await open(retained, "wx", 0o400);
            await handle.writeFile(bytes);
            await handle.sync();
          } catch (error) {
            if (!(error instanceof Error) || error.code !== "EEXIST") throw error;
            if ((await lstat(retained)).isSymbolicLink() || !(await readFile(retained)).equals(bytes))
              throw new WorkError("artifact-preservation", "Artifact retention collision; existing bytes were not replaced.");
          } finally { await handle?.close(); }
          preservedArtifacts[original] = { path: relative(retained), sha256: expectedHash };
        }
        await chmod(directory, 0o500);
        for (const folder of [directory, store, path.join(root, ".beads")]) {
          const handle = await open(folder, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        }
        await publishRefresh({ phase: "retained", artifacts: preservedArtifacts });
        }
      }
      // All prior proof and receipt metadata survives in an append-only comment.
      // Existing comments stay in Beads. Failed cancellation may release its
      // exact reservation; the archive records intent rather than success.
      let recorded = false;
      if (operation === "refresh-first-case") {
        for (const comment of await bd(["comments", id])) {
          let envelope;
          try { envelope = JSON.parse(String(comment.text ?? comment.body ?? "")); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
          if (envelope?.kind !== "recovery" || envelope.operation !== operation ||
              envelope.refreshId !== activeWork.refresh.id) continue;
          if (!isDeepStrictEqual(envelope.previous?.accepted, work.accepted) ||
              !isDeepStrictEqual(envelope.preservedArtifacts, preservedArtifacts))
            throw new WorkError("recovery", "The durable refresh archive conflicts with its protected generation.");
          recorded = true;
        }
      }
      if (!recorded) await bd(["comments", "add", id, JSON.stringify({ kind: "recovery", reason,
        operation: operation || "recover", transitionOwner: recovering,
        ...(operation === "refresh-first-case" ? { refreshId: activeWork.refresh.id } : {}),
        ...(preservedArtifacts ? { preservedArtifacts } : {}),
        previous: work, previousDispatch: value.metadata?.qrclipDispatch || null,
        assignee, status, session: actor, recordedAt: new Date().toISOString() })]);
      else await bd(["comments", "add", id, JSON.stringify({ kind: "recovery-resume", reason,
        refreshId: activeWork.refresh.id, transitionOwner: recovering, assignee, status,
        session: actor, recordedAt: new Date().toISOString() })]);
      if (operation === "refresh-first-case") await publishRefresh({ phase: "commented" });
      const cancelled = operation === "cancel-expansion";
      const retainedArtifacts = [...new Set([
        ...(work.retiredArtifacts || []),
        ...(operation === "refresh-first-case"
          ? [work.accepted.receipt.path, ...Object.keys(work.accepted.firstCase.artifacts)] : []),
      ])];
      await update(id, ["--if-assignee", recovering, "--if-status", "blocked",
        "--assignee", "", "--status", cancelled ? "closed" : "open", "--metadata",
        JSON.stringify({ qrclipWork: { version: 1, paths: work.paths, fixture: work.fixture,
          ...(retainedArtifacts.length ? { retiredArtifacts: retainedArtifacts } : {}),
          ...((work.artifactArchives?.length || preservedArtifacts) ? {
            artifactArchives: [...(work.artifactArchives || []),
              ...(preservedArtifacts ? [{ refreshId: activeWork.refresh.id,
                receipt: work.accepted.receipt, artifacts: preservedArtifacts }] : [])],
          } : {}),
          ...(cancelled ? { cancelled: { attempt: work.attempt?.id || null,
            transitionOwner: recovering, reason, recordedAt: new Date().toISOString() } } : {}),
        }, qrclipDispatch: null })], recovering);
      return packet(id);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (operation === "cancel-expansion") {
          try {
            const latest = await issue(id);
            // A reopen can make normal closure fail after preflight. Restore
            // only our exact untouched reservation, using the unique token in
            // the release CAS too. A replacement owner or altered proof stays
            // untouched; a lost successful-close response cannot reopen work.
            if (latest.assignee === recovering && latest.status === "blocked" &&
                JSON.stringify({ work: workData(latest),
                  dispatch: latest.metadata?.qrclipDispatch || null }) === prior)
              await update(id, ["--if-assignee", recovering, "--if-status", "blocked",
                "--assignee", guardedAssignee, "--status", status], recovering);
          } catch (releaseError) {
            throw new AggregateError([error, releaseError],
              "Cancellation failed and its reservation could not be safely released; inspect before recovery.");
          }
        }
        throw error;
      }
    },
    async note(id, { kind, text, source, observedAt }) {
      await issue(id);
      if (!WORK_INTERFACE.noteKinds.includes(kind) ||
          typeof text !== "string" || !text || text.length > 4000 ||
          (source != null && (typeof source !== "string" || source.length > 4000)) ||
          (observedAt != null && (typeof observedAt !== "string" || observedAt.length > 80)))
        throw new WorkError("input", `note requires kind: ${WORK_INTERFACE.noteKinds.join(" | ")}; text must be a nonempty string of at most 4000 characters, source at most 4000, and observedAt at most 80.`);
      const note = { kind, text, source: source || null,
        observedAt: observedAt || null, recordedAt: new Date().toISOString(), session: actor };
      await bd(["comments", "add", id, JSON.stringify(note)]);
      return note;
    },
    async prepare(id, { mode = "delegate", name = actor } = {}) {
      const value = await issue(id);
      const work = workData(value);
      if (!["delegate", "direct"].includes(mode)) throw new WorkError("mode", "Unknown work mode.");
      if (value.status !== "open" || value.assignee)
        throw new WorkError("state", "Only unassigned open work can be prepared; use explicit recovery.");
      if (work.attempt || work.refresh || work.accepted || value.metadata?.qrclipDispatch)
        throw new WorkError("state", "Recover the prior attempt and its receipt before preparing new work.");
      const upstream = await prerequisites(value, { admission: true });
      const sources = await fingerprint(work.paths);
      const attempt = randomUUID();
      const preparing = `${actorFor(attempt)}:prepare:${randomUUID()}`;
      const prior = JSON.stringify({ work, dispatch: value.metadata?.qrclipDispatch || null });
      await update(id, ["--if-assignee", "", "--if-status", "open",
        "--assignee", preparing, "--status", "blocked"], preparing);
      let protectedState;
      try {
        const latest = await issue(id);
        if (latest.assignee !== preparing || latest.status !== "blocked")
          throw new WorkError("ownership", "The preparation transition is no longer owned.");
        const current = workData(latest);
        protectedState = JSON.stringify({ work: current, dispatch: latest.metadata?.qrclipDispatch || null });
        if (protectedState !== prior)
          throw new WorkError("stale-input", "Work changed across preparation; reassess the current contract and historical artifacts.");
        const protectedUpstream = await prerequisites(latest, { admission: true });
        if (!isDeepStrictEqual(protectedUpstream.receipts, upstream.receipts) ||
            JSON.stringify(await fingerprint(current.paths)) !== JSON.stringify(sources))
          throw new WorkError("stale-input", "Preparation inputs changed during reservation.");
        await verifyArtifactArchives(current);
        await update(id, ["--if-assignee", preparing, "--if-status", "blocked",
          "--assignee", actorFor(attempt), "--status", mode === "delegate" ? "hooked" : "in_progress",
          "--metadata", JSON.stringify({ qrclipWork: {
            ...current, attempt: { id: attempt, coordinator: actor, name: String(name).slice(0,100),
              mode, sources, prerequisites: protectedUpstream.receipts, preparedAt: new Date().toISOString() },
          } })], preparing);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        try {
          const latest = await issue(id);
          if (latest.assignee === preparing && latest.status === "blocked" &&
              protectedState === JSON.stringify({ work: workData(latest),
                dispatch: latest.metadata?.qrclipDispatch || null }))
            await update(id, ["--if-assignee", preparing, "--if-status", "blocked",
              "--assignee", "", "--status", "open"], preparing);
        } catch (releaseError) {
          throw new AggregateError([error, releaseError],
            "Preparation failed and its reservation could not be safely released; inspect before recovery.");
        }
        throw error;
      }
      return { id, attempt, marker: workMarker(id, attempt), packet: await packet(id),
        hints: { noteKinds: WORK_INTERFACE.noteKinds,
          ...(work.fixture?.stage === "first-case" ? {
            check: "Supply firstCase {report, visualEvidence}; the executed report and observation must carry the fresh workCheck binding.",
            review: { type: "string", maxCharacters: WORK_INTERFACE.reviewMaxCharacters,
              purpose: "Coordinator inspection of the executed case and actual evidence." },
          } : {}) } };
    },
    async beginDispatch(id, attempt) {
      const { value, work } = await owned(id, attempt);
      if (work.attempt.coordinator !== actor)
        throw new WorkError("ownership", "Only the preparing session can dispatch this attempt.");
      const upstream = await prerequisites(value, { admission: true });
      if (!isDeepStrictEqual(upstream.receipts, work.attempt.prerequisites))
        throw new WorkError("stale-input", "Prerequisite acceptance changed after preparation; reassess this attempt.");
      if (!isDeepStrictEqual(await fingerprint(work.paths), work.attempt.sources))
        throw new WorkError("stale-input", "Relevant inputs changed after preparation; reassess this attempt.");
      const result = await update(id, ["--if-assignee", actorFor(attempt),
        "--if-status", "hooked", "--assignee", `${actorFor(attempt)}:dispatch:${randomUUID()}`,
        "--status", "blocked"], actorFor(attempt));
      const dispatching = result.assignee;
      try {
        const latest = await issue(id);
        if (latest.assignee !== dispatching || latest.status !== "blocked" ||
            JSON.stringify(workData(latest)) !== JSON.stringify(work) || latest.metadata?.qrclipDispatch)
          throw new WorkError("ownership", "The dispatch transition is no longer owned.");
        const protectedUpstream = await prerequisites(latest, { admission: true });
        await verifyArtifactArchives(workData(latest));
        if (!isDeepStrictEqual(protectedUpstream.receipts, work.attempt.prerequisites) ||
            !isDeepStrictEqual(await fingerprint(work.paths), work.attempt.sources))
          throw new WorkError("stale-input", "Dispatch inputs changed during reservation.");
        await update(id, ["--if-assignee", dispatching, "--if-status", "blocked",
          "--assignee", actorFor(attempt), "--status", "in_progress"], dispatching);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        try {
          await update(id, ["--if-assignee", dispatching, "--if-status", "blocked",
            "--assignee", actorFor(attempt), "--status", "hooked"], dispatching);
        } catch (releaseError) {
          throw new AggregateError([error, releaseError],
            "Dispatch failed and its exclusive owner could not be released; inspect before explicit recovery.");
        }
        throw error;
      }
      return packet(id);
    },
    async dispatched(id, attempt, result) {
      const { value } = await owned(id, attempt);
      const receipt = { attemptId: attempt, taskId: result.taskId || null, childSession: result.childSession || null,
        error: result.error || null, toolCallId: result.toolCallId || null,
        nativeStatus: result.nativeStatus || null, resultSha256: result.resultSha256 || null,
        outcome: result.outcome || "returned", recordedAt: new Date().toISOString() };
      if (value.metadata?.qrclipDispatch) throw new WorkError("state", "A dispatch receipt already exists.");
      if (value.status !== "in_progress") throw new WorkError("state", "Only active work can receive a dispatch receipt.");
      // Receipt publication has its own unique owner so two late native results
      // cannot both pass the duplicate check after an owner/status ABA.
      const publishing = `${actorFor(attempt)}:receipt:${randomUUID()}`;
      await update(id, ["--if-assignee", actorFor(attempt), "--if-status", "in_progress",
        "--assignee", publishing, "--status", "blocked"], actorFor(attempt));
      try {
        const latest = await issue(id);
        if (latest.assignee !== publishing || workData(latest).attempt?.id !== attempt)
          throw new WorkError("ownership", "The receipt publication is no longer owned.");
        if (latest.metadata?.qrclipDispatch)
          throw new WorkError("state", "A dispatch receipt already exists.");
        // Beads merges top-level metadata keys. Never write a qrclipWork
        // snapshot here: a newer check may have completed before reservation.
        await update(id, ["--if-assignee", publishing, "--if-status", "blocked",
          "--assignee", actorFor(attempt), "--status", receipt.error ? "blocked" : "in_progress",
          "--metadata", JSON.stringify({ qrclipDispatch: receipt })], publishing);
        return receipt;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        try {
          await update(id, ["--if-assignee", publishing, "--if-status", "blocked",
            "--assignee", actorFor(attempt), "--status", "in_progress"], publishing);
        } catch (releaseError) {
          if (!(releaseError instanceof Error)) throw releaseError;
          throw new AggregateError([error, releaseError],
            "Receipt publication failed and its exclusive owner could not be released; inspect before explicit recovery.");
        }
        throw error;
      }
    },
    async check(id, attempt, { command, args = [], budgetMs = 60000, kind = "measurement",
      expectedExitCodes = [0], cleanup, firstCase, outputDirectories = [], wslFixtureException,
      trustedFixture, retainedEvidence, env: checkEnvironment }) {
      const started = performance.now();
      const { value, work } = await owned(id, attempt);
      if (value.status !== "in_progress") throw new WorkError("state", "Only active work can be checked.");
      if (work.refresh || work.accepted)
        throw new WorkError("state", "An accepted or interrupted generation cannot execute another check.");
      const onWsl = process.platform === "linux" && /microsoft|wsl/i.test(`${release()} ${version()}`);
      const evidence = retainedEvidence === undefined ? undefined : parseRetainedEvidence(retainedEvidence);
      let trustedAction;
      if (trustedFixture !== undefined) {
        if (typeof trustedFixture !== "string" || !Object.hasOwn(trustedFixtures, trustedFixture) ||
            command !== undefined || args.length || cleanup !== undefined ||
            expectedExitCodes.length !== 1 || expectedExitCodes[0] !== 0 ||
            kind !== "functional" || retainedEvidence !== undefined || wslFixtureException !== undefined ||
            checkEnvironment !== undefined ||
            firstCase !== undefined || !Array.isArray(outputDirectories) || outputDirectories.length !== 0 ||
            (work.fixture?.stage !== undefined && work.fixture.stage !== "first-case") ||
            work.attempt.mode !== "direct" ||
            work.attempt.coordinator !== actor)
          throw new WorkError("trusted-fixture",
            "Trusted fixture checks require an exact grant, active direct work, and no caller-supplied actions.");
        try {
          const resolved = await resolveTrustedFixture({
            trustedFixtures, fixtureId: trustedFixture, projectRoot: root,
          });
          if (!resolved || !resolved.descriptor || !/^[a-f0-9]{64}$/.test(resolved.descriptorSha256) ||
              !Array.isArray(resolved.projectInputs))
            throw new WorkError("trusted-fixture", "The resolver returned an invalid trusted fixture descriptor.");
          const { descriptor, descriptorSha256, projectInputs } = resolved;
          const actions = [
            descriptor,
            descriptor.cleanup, descriptor.verifyCleanup,
          ];
          if (descriptor.version !== 1 || actions.some(action => !action ||
              typeof action.executable !== "string" || !path.isAbsolute(action.executable) ||
              !/^[a-f0-9]{64}$/.test(action.sha256) || !Array.isArray(action.args) ||
              action.args.some(arg => typeof arg !== "string")) ||
              !descriptor.env || typeof descriptor.env !== "object" ||
              Array.isArray(descriptor.env) ||
              Object.values(descriptor.env).some(value => typeof value !== "string"))
            throw new WorkError("trusted-fixture", "The resolver returned invalid pinned fixture actions.");
          trustedAction = {
            descriptor, descriptorSha256, projectInputs, id: trustedFixture,
            checkFirstCase: work.fixture?.stage === "first-case",
          };
        } catch (error) {
          if (error instanceof WorkError) throw error;
          throw new WorkError("trusted-fixture",
            `The trusted fixture grant could not be resolved: ${error.reason ?? error.message}`, { cause: error });
        }
      }
      if (evidence && (process.platform !== "linux" || (onWsl && allowWslEvidenceChecks !== true)))
        throw new WorkError("artifact-protection-unavailable",
          "Retained-evidence verification requires Linux and, on WSL, the trusted project's allowWslEvidenceChecks opt-in.");
      if (evidence && (work.fixture || work.attempt.mode !== "direct" || work.attempt.coordinator !== actor ||
          !value.dependencies?.some(dependency => dependency.dependency_type === "blocks") ||
          kind !== "functional" || command !== undefined || !Array.isArray(args) || args.length ||
          cleanup !== undefined || firstCase !== undefined || wslFixtureException !== undefined ||
          !Array.isArray(outputDirectories) || outputDirectories.length ||
          !Array.isArray(expectedExitCodes) || expectedExitCodes.length !== 1 || expectedExitCodes[0] !== 0))
        throw new WorkError("retained-evidence",
          "Only the direct coordinator of a protected non-fixture item can run a functional retained-evidence check, with no commands, cleanup or writable outputs.");
      let isolationException;
      if (wslFixtureException !== undefined) {
        if (!wslFixtureException || typeof wslFixtureException !== "object" || Array.isArray(wslFixtureException) ||
            Object.keys(wslFixtureException).some(key => !["id", "attempt", "reason"].includes(key)) ||
            wslFixtureException.id !== id || wslFixtureException.attempt !== attempt ||
            typeof wslFixtureException.reason !== "string" ||
            wslFixtureException.reason.trim().length < 10 || wslFixtureException.reason.length > 4000)
          throw new WorkError("wsl-fixture-exception", "Use wslFixtureException {id,attempt,reason} matching this check, with a rationale of 10-4000 characters.");
        if (!onWsl || work.fixture?.stage !== "first-case" || work.fixture.visual !== false ||
            work.attempt.coordinator !== actor)
          throw new WorkError("wsl-fixture-exception", "Only the preparing coordinator may waive filesystem isolation for a declared nonvisual first case on WSL.");
        isolationException = { id, attempt, reason: wslFixtureException.reason.trim(), coordinator: actor };
      }
      if (!["measurement", "functional"].includes(kind))
        throw new WorkError("input", "check kind must be measurement or functional.");
      const maxBudgetMs = kind === "measurement" ? WORK_INTERFACE.measurementMaxMs : WORK_INTERFACE.functionalMaxMs;
      if ((!evidence && !trustedAction && (typeof command !== "string" || !command)) ||
          !Array.isArray(args) || args.some(arg => typeof arg !== "string") ||
          !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > maxBudgetMs)
        throw new WorkError("input", `Use an executable, string arguments and a 1-${maxBudgetMs / 1000} second ${kind} check.`);
      if (!Array.isArray(expectedExitCodes) || !expectedExitCodes.length ||
          expectedExitCodes.some(code => !Number.isInteger(code) || code < 0 || code > 255) ||
          (cleanup && (typeof cleanup.command !== "string" || !Array.isArray(cleanup.args) ||
            cleanup.args.some(arg => typeof arg !== "string"))))
        throw new WorkError("input", "Use valid expected exit codes and an executable cleanup with string arguments.");
      if (!Array.isArray(outputDirectories) || outputDirectories.length > 16 ||
          outputDirectories.some(directory => typeof directory !== "string"))
        throw new WorkError("input", "Use at most 16 explicitly writable fresh output directories.");
      if (work.fixture?.stage === "first-case") {
        if (!trustedAction && (!firstCase || typeof firstCase.report !== "string" ||
            (firstCase.manifest !== undefined && typeof firstCase.manifest !== "string") ||
            (firstCase.observationDirectory !== undefined && typeof firstCase.observationDirectory !== "string") ||
            !Array.isArray(firstCase.visualEvidence) || firstCase.visualEvidence.some(file => typeof file !== "string") ||
            expectedExitCodes.length !== 1 || expectedExitCodes[0] !== 0))
          throw new WorkError("fixture-evidence", "First-case checks require terminal evidence and a successful command.");
        if (!trustedAction && [firstCase.report, ...(firstCase.manifest === undefined ? [] : [firstCase.manifest]), ...firstCase.visualEvidence].some(file =>
          work.retiredArtifacts?.includes(relative(file))))
          throw new WorkError("fixture-evidence", "Refreshed first-case execution requires new artifact paths; preserve the archived proof.");
        if (!trustedAction && work.retiredArtifacts?.length && firstCase.manifest === undefined && firstCase.observationDirectory === undefined)
          throw new WorkError("fixture-evidence", "Protected first cases require a fresh manifest path or observation output directory.");
        if (!trustedAction && firstCase.observationDirectory !== undefined) {
          const directory = relative(firstCase.observationDirectory);
          await fingerprint([directory], { includeIgnored: true });
          if (!(await lstat(path.join(root, directory))).isDirectory() ||
              (await readdir(path.join(root, directory))).length ||
              work.retiredArtifacts?.some(file => file === directory || file.startsWith(directory + path.sep)))
            throw new WorkError("fixture-evidence", "Declare an existing empty observation output directory disjoint from historical evidence.");
        }
      } else if (firstCase !== undefined) {
        throw new WorkError("fixture-evidence", "Declare first-case work before attaching platform evidence.");
      }
      // Every blocking prerequisite protects at least its accepted receipt.
      // Check before reserving an owner, creating receipts or launching either
      // command. WSL interop executes outside the Linux mount namespace, and
      // hiding one socket does not close other host IPC/service write routes.
      // Kernel identity, rather than removable WSL environment variables, owns
      // this decision. The fixed evidence verifier launches no caller command.
      const protectsArtifacts = work.retiredArtifacts?.length || work.artifactArchives?.length ||
        (value.dependencies || []).some(dependency => dependency.dependency_type === "blocks");
      if (protectsArtifacts && onWsl && !isolationException && !evidence && !trustedAction)
        throw new WorkError("artifact-protection-unavailable",
          "Protected checks are unavailable on WSL: Windows interop and host IPC escape the Linux read-only filesystem view. No check or cleanup command was launched. Protected Windows ADB and stage6 fixtures cannot run here.");
      let trustedBaseline;
      if (trustedAction?.descriptor.evidenceSeal) {
        try {
          const historicPaths = await verifyArtifactArchives(work);
          const upstream = await prerequisites(value);
          const external = Boolean(trustedAction.descriptor.evidenceSeal.archiveRoot);
          const expectedFiles = await trustedEvidenceFiles(
            work, upstream, historicPaths, trustedAction.projectInputs, { external });
          const entries = Object.entries(expectedFiles);
          if (!entries.length || entries.some(([file, digest]) =>
            !file || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))
            throw new WorkError("trusted-fixture-seal",
              "A sealed trusted fixture requires complete, present authoritative evidence files.");
          trustedBaseline = external
            ? await captureTrustedEvidence(work, upstream, historicPaths)
            : { ...expectedFiles };
          const seal = await verifyEvidenceSeal({
            projectRoot: root,
            manifestPath: trustedAction.descriptor.evidenceSeal.manifest,
            ...(external && { archiveRoot: trustedAction.descriptor.evidenceSeal.archiveRoot }),
            expectedFiles,
          });
          if (!seal || seal.version !== 1 || !/^[a-f0-9]{64}$/.test(seal.manifestSha256) ||
              seal.fileCount !== entries.length ||
              (external && seal.archiveRoot !== trustedAction.descriptor.evidenceSeal.archiveRoot))
            throw new WorkError("trusted-fixture-seal",
              "The trusted fixture evidence seal returned unsupported or incomplete proof metadata.");
          trustedAction.expectedFiles = expectedFiles;
          trustedAction.evidenceSeal = {
            manifest: trustedAction.descriptor.evidenceSeal.manifest,
            ...(external && { archiveRoot: seal.archiveRoot }),
            version: seal.version, manifestSha256: seal.manifestSha256, fileCount: seal.fileCount,
          };
          if (performance.now() - started >= budgetMs)
            throw new WorkError("deadline", "The check budget expired while verifying the evidence seal.");
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (error instanceof WorkError) throw error;
          throw new WorkError("trusted-fixture-seal",
            `The trusted fixture evidence seal could not be verified: ${error.reason ?? error.message}`,
            { cause: error });
        }
      }
      const checking = `${actorFor(attempt)}:check:${randomUUID()}`;
      await update(id, ["--if-assignee", actorFor(attempt), "--if-status", "in_progress",
        "--assignee", checking, "--status", "blocked"], actorFor(attempt));
      const checkedOwner = async () => {
        const current = await issue(id);
        if (current.assignee !== checking || workData(current).attempt?.id !== attempt)
          throw new WorkError("ownership", "The check transition is no longer owned.");
        return { value: current, work: workData(current) };
      };
      const releaseFailedCheck = async (error, status = "in_progress") => {
        try {
          const latest = await checkedOwner();
          await update(id, ["--if-assignee", checking, "--if-status", "blocked",
            "--assignee", actorFor(attempt), "--status", status, "--metadata",
            JSON.stringify({ qrclipWork: { ...latest.work, checked: null } })], checking);
        } catch (releaseError) {
          throw new AggregateError([error, releaseError],
            "Check failed and its owner could not be released safely; inspect before explicit recovery.");
        }
        throw error;
      };
      let upstream, proofPaths, sources, context, historicPaths, sandboxExecutable, allEvidence;
      let reservedTrustedFiles;
      let sandboxArguments = [];
      try {
        historicPaths = await verifyArtifactArchives(work);
        upstream = await prerequisites(value);
        allEvidence = mergeRetainedEvidence(upstream.retainedEvidence, evidence ?? []);
        historicPaths = [...new Set([...historicPaths, ...upstream.protectedArtifacts])];
        if (trustedAction) {
          const latestOwned = await checkedOwner();
          const latestPrerequisites = await prerequisites(latestOwned.value);
          if (!isDeepStrictEqual(upstream.receipts, latestPrerequisites.receipts))
            throw new WorkError("trusted-fixture-seal",
              "Accepted prerequisite receipts changed after check reservation.");
          const currentBaseline = trustedAction.evidenceSeal
            ? await trustedEvidenceFiles(latestOwned.work, latestPrerequisites, historicPaths,
              trustedAction.projectInputs, {
                external: Boolean(trustedAction.descriptor.evidenceSeal?.archiveRoot),
              })
            : await captureTrustedEvidence(work, upstream, historicPaths);
          if (trustedAction.evidenceSeal && trustedAction.descriptor.evidenceSeal.archiveRoot &&
              !isDeepStrictEqual(currentBaseline, trustedAction.expectedFiles))
            throw new WorkError("trusted-fixture-seal",
              "Accepted archive evidence changed after check reservation.");
          if (trustedAction.evidenceSeal && !trustedAction.descriptor.evidenceSeal.archiveRoot &&
              !isDeepStrictEqual(currentBaseline, trustedBaseline))
            throw new WorkError("trusted-fixture-seal",
              "Authoritative evidence changed after its manifest seal was verified.");
          reservedTrustedFiles = trustedAction.evidenceSeal &&
            trustedAction.descriptor.evidenceSeal.archiveRoot ? currentBaseline : undefined;
          trustedBaseline = trustedAction.evidenceSeal &&
            trustedAction.descriptor.evidenceSeal.archiveRoot
            ? await captureTrustedEvidence(latestOwned.work, latestPrerequisites, historicPaths)
            : currentBaseline;
          const output = path.relative(root, await mkdtemp(path.join(root, ".trusted-fixture-run-")));
          await mkdir(path.join(root, output, "observations"), { mode: 0o700 });
          trustedAction.outputDirectory = output;
          trustedAction.observationDirectory = path.join(output, "observations");
          trustedAction.report = path.join(output, "report.json");
          if (work.fixture?.stage === "first-case")
            trustedAction.firstCaseBaseline = await captureTrustedEvidence(work, upstream,
              historicPaths);
        }
        if (!trustedAction && work.fixture?.stage === "first-case" &&
            [firstCase.report, ...(firstCase.manifest === undefined ? [] : [firstCase.manifest]), ...firstCase.visualEvidence].some(file => historicPaths.includes(relative(file))))
          throw new WorkError("fixture-evidence", "First-case outputs must be fresh report, manifest and visual destinations.");
        if (historicPaths.length && !evidence && !trustedAction) {
          if (firstCase && firstCase.manifest === undefined && firstCase.observationDirectory === undefined)
            throw new WorkError("fixture-evidence", "Protected first cases require a fresh manifest path or observation output directory.");
          if (process.platform !== "linux")
            throw new WorkError("artifact-protection-unavailable", "Protected checks require a working unprivileged Linux bubblewrap filesystem view.");
          for (const folder of isolationException ? [] : (process.env.PATH || "").split(path.delimiter)) {
            const candidate = path.resolve(folder || root, "bwrap");
            try {
              await access(candidate, fsConstants.X_OK);
              sandboxExecutable = await realpath(candidate);
              break;
            } catch (error) {
              if (!(error instanceof Error) || !["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
            }
          }
          if (!sandboxExecutable && !isolationException)
            throw new WorkError("artifact-protection-unavailable", "Bubblewrap was not found; no check or cleanup command was launched.");
          const protectedInodes = new Set();
          const protectedAncestors = new Set();
          for (const file of [...historicPaths.map(file => path.join(root, relative(file))),
            ...(sandboxExecutable ? [sandboxExecutable] : [])]) {
            const stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new WorkError("artifact-protection-unavailable", "Protected paths must identify regular files.");
            protectedInodes.add(`${stat.dev}:${stat.ino}`);
            for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
              const parent = await lstat(folder);
              protectedAncestors.add(`${parent.dev}:${parent.ino}`);
              if (folder === path.dirname(folder)) break;
            }
          }
          const destinations = firstCase
            ? [firstCase.report, ...(firstCase.manifest === undefined ? [] : [firstCase.manifest]), ...firstCase.visualEvidence]
              .map(file => path.dirname(relative(file))).concat(
                firstCase.observationDirectory === undefined ? [] : [relative(firstCase.observationDirectory)]) : [];
          const requested = [...new Set([...outputDirectories.map(relative), ...destinations])].sort((a, b) => a.length - b.length);
          const writable = requested.filter((directory, index) =>
            !requested.slice(0, index).some(parent => directory === parent || directory.startsWith(parent + path.sep)));
          for (const directory of writable) {
            const full = path.join(root, directory);
            if (full === root || directory === ".beads" || directory.startsWith(".beads" + path.sep) ||
                historicPaths.some(file => file === directory || file.startsWith(directory + path.sep)))
              throw new WorkError("fixture-evidence", "Writable output directories must be fresh and disjoint from historical artifacts and receipt storage.");
            if (!(await lstat(full)).isDirectory())
              throw new WorkError("fixture-evidence", "Create each explicitly fresh output directory before checking.");
          }
          const entries = await fingerprint(writable, { includeIgnored: true });
          for (const file of Object.keys(entries)) {
            const stat = await lstat(path.join(root, file));
            const inode = `${stat.dev}:${stat.ino}`;
            if (protectedInodes.has(inode) || protectedAncestors.has(inode) || (stat.isFile() && stat.nlink !== 1))
              throw new WorkError("fixture-evidence", "Fresh writable output trees cannot alias historical files or their parents.");
          }
          if (!isolationException) {
            sandboxArguments = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
              "--cap-drop", "ALL", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
              "--tmpfs", "/tmp", "--ro-bind", root, root,
              ...writable.flatMap(directory => ["--bind", path.join(root, directory), path.join(root, directory)]),
              "--chdir", root, "--"];
            const probeMs = Math.min(5000, Math.floor(budgetMs * 0.7 - (performance.now() - started) - 350));
            if (probeMs <= 0) throw new WorkError("deadline", "No functional deadline remains for filesystem isolation preflight.");
            try {
              await execute(sandboxExecutable, [...sandboxArguments, process.execPath, "-e", ""],
                { cwd: root, env: process.env, timeout: probeMs, maxBuffer: 65536 });
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              throw new WorkError("artifact-protection-unavailable",
                "Read-only filesystem isolation failed before any command or cleanup: " + error.message, { cause: error });
            }
          }
        }
        proofPaths = [...new Set([...upstream.paths, ...work.paths])].sort();
        sources = await fingerprint(proofPaths);
        if (trustedAction) {
          for (const [file, digest] of Object.entries(sources))
            if (/^[a-f0-9]{64}$/.test(digest)) trustedBaseline[file] = digest;
        }
        const elapsed = Math.ceil(performance.now() - started);
        const primaryMs = Math.floor(budgetMs * 0.7) - elapsed;
        if (primaryMs <= 350)
          throw new WorkError("deadline", "The check budget expired during preflight; no command was launched.");
        context = await createRunContext({
          output: path.join(root, ".beads", "checks"), scenario: "agent-work-check",
          budgetMs: budgetMs - elapsed, primaryMs,
          cleanupMs: Math.floor(budgetMs * 0.25), publicationMs: Math.floor(budgetMs * 0.05),
        });
        if (isolationException)
          context.phase("filesystem-isolation", "waived", { filesystemIsolation: false,
            receipt: "wsl-fixture-receipt.json" });
        if (trustedAction)
          context.phase("filesystem-isolation", "detection-only", {
            filesystemIsolation: false, detectionOnly: true,
            trustedFixture: trustedAction.descriptorSha256,
            ...(trustedAction.evidenceSeal && { evidenceSeal: trustedAction.evidenceSeal }),
          });
      } catch (error) {
        await releaseFailedCheck(error, error instanceof WorkError && error.code === "blocked"
          ? "blocked" : "in_progress");
      }
      try {
      let passed = false;
      let primaryError;
      const run = { nonce: randomUUID(), id, attempt };
      const trustedEnv = trustedAction ? {
        ...trustedAction.descriptor.env,
        QRCLIP_AGENT_NAME: work.attempt.name,
        QRCLIP_AGENT_SESSION: actor,
        QRCLIP_AGENT_WORK_ID: id,
        QRCLIP_WORK_CHECK_NONCE: run.nonce,
        QRCLIP_WORK_CHECK_ATTEMPT: attempt,
        QRCLIP_HARNESS_OUTPUT: path.join(root, trustedAction.observationDirectory),
        QRCLIP_HARNESS_DEADLINE_EPOCH_MS: String(Date.now() + Math.max(0, budgetMs - (performance.now() - started))),
      } : undefined;
      const resolvePinnedTrustedAction = async () => {
        const current = await resolveTrustedFixture({
          trustedFixtures, fixtureId: trustedAction.id, projectRoot: root,
        });
        if (current.descriptorSha256 !== trustedAction.descriptorSha256)
          throw new WorkError("trusted-fixture", "The trusted fixture grant changed before action use.");
        if (trustedAction.evidenceSeal?.archiveRoot &&
            current.descriptor.evidenceSeal?.archiveRoot !== trustedAction.evidenceSeal.archiveRoot)
          throw new WorkError("trusted-fixture", "The granted evidence archive root changed before action use.");
        return current.descriptor;
      };
      const verifyTrustedSeal = async () => {
        if (!trustedAction.evidenceSeal) return;
        try {
          if (trustedAction.evidenceSeal.archiveRoot) {
            const current = await checkedOwner();
            const currentUpstream = await prerequisites(current.value);
            if (!isDeepStrictEqual(upstream.receipts, currentUpstream.receipts))
              throw new WorkError("trusted-fixture-seal",
                "Accepted prerequisite receipts changed after check reservation.");
            const currentFiles = await trustedEvidenceFiles(current.work, currentUpstream,
              historicPaths, trustedAction.projectInputs, { external: true });
            if (!isDeepStrictEqual(currentFiles, reservedTrustedFiles))
              throw new WorkError("trusted-fixture-seal",
                "Accepted archive evidence changed after check reservation.");
          }
          const seal = await verifyEvidenceSeal({
            projectRoot: root,
            manifestPath: trustedAction.evidenceSeal.manifest,
            ...(trustedAction.evidenceSeal.archiveRoot && {
              archiveRoot: trustedAction.evidenceSeal.archiveRoot,
            }),
            expectedFiles: trustedAction.expectedFiles,
          });
          if (!seal || seal.version !== trustedAction.evidenceSeal.version ||
              seal.manifestSha256 !== trustedAction.evidenceSeal.manifestSha256 ||
              seal.fileCount !== trustedAction.evidenceSeal.fileCount ||
              seal.archiveRoot !== (trustedAction.evidenceSeal.archiveRoot || undefined))
            throw new WorkError("trusted-fixture-seal",
              "The trusted fixture evidence seal changed after preflight.");
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (error instanceof WorkError) throw error;
          throw new WorkError("trusted-fixture-seal",
            `The trusted fixture evidence seal is no longer valid: ${error.reason ?? error.message}`,
            { cause: error });
        }
      };
      try {
        const commandWhole = Math.floor(context.deadlines.primaryEpochMs - 350);
        if (evidence) {
          context.phase("retained-evidence", "read-only", {
            files: evidence.length, commands: false, evidenceSha256: hash(JSON.stringify(evidence)),
          });
          await verifyRetainedEvidence(evidence, performance.now() + context.deadlines.remaining().primaryMs);
        } else if (trustedAction) {
          const descriptor = await resolvePinnedTrustedAction();
          await verifyTrustedSeal();
          await context.runCommand(descriptor.executable, descriptor.args, {
            cwd: path.join(root, trustedAction.outputDirectory), label: "trusted-fixture",
            expectedExitCodes: [0], env: trustedEnv,
          });
        } else await context.runCommand(sandboxExecutable || command,
          sandboxExecutable ? [...sandboxArguments, command, ...args] : args, { cwd: root, label: "work-check", expectedExitCodes,
          env: { ...process.env, QRCLIP_AGENT_NAME: work.attempt.name,
            QRCLIP_AGENT_SESSION: actor, QRCLIP_AGENT_WORK_ID: id,
            QRCLIP_WORK_CHECK_NONCE: run.nonce, QRCLIP_WORK_CHECK_ATTEMPT: attempt,
            QRCLIP_HARNESS_DEADLINE_EPOCH_MS: String(commandWhole) } });
        const current = await prerequisites(await issue(id));
        passed = isDeepStrictEqual(upstream.receipts, current.receipts) &&
          JSON.stringify(sources) === JSON.stringify(await fingerprint(proofPaths));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        primaryError = error;
      }
      const cleanupErrors = [];
      let trustedSealFailed = primaryError?.code === "trusted-fixture-seal";
      if (trustedAction && !trustedSealFailed) {
        try {
          const action = await resolvePinnedTrustedAction().then(descriptor => descriptor.cleanup);
          await verifyTrustedSeal();
          await context.runCommand(action.executable, action.args, {
            cwd: path.join(root, trustedAction.outputDirectory), phase: "cleanup",
            label: "trusted-fixture-cleanup", expectedExitCodes: [0],
            env: trustedEnv,
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          cleanupErrors.push(error);
          trustedSealFailed ||= error.code === "trusted-fixture-seal";
        }
      } else if (cleanup) {
        try {
          await context.runCommand(sandboxExecutable || cleanup.command,
            sandboxExecutable ? [...sandboxArguments, cleanup.command, ...cleanup.args] : cleanup.args,
            { cwd: root, phase: "cleanup", label: "work-cleanup" });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          cleanupErrors.push(error);
        }
      }
      // Cleanup may touch inputs too; evidence covers the terminal revision.
      let detectionViolations = [];
      let verifierResult = "not-run";
      if (trustedAction && !trustedSealFailed) {
        verifierResult = "failed";
        try {
          const action = await resolvePinnedTrustedAction().then(descriptor => descriptor.verifyCleanup);
          await verifyTrustedSeal();
          await context.runCommand(action.executable, action.args, {
            cwd: path.join(root, trustedAction.outputDirectory), phase: "cleanup",
            label: "trusted-fixture-independent-verifier", expectedExitCodes: [0],
            env: trustedEnv,
          });
          verifierResult = "passed";
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          detectionViolations.push({ path: "cleanup-verifier", reason: error.code || error.name });
          trustedSealFailed ||= error.code === "trusted-fixture-seal";
        }
        try {
          if (!isDeepStrictEqual(sources, await fingerprint(proofPaths)))
            detectionViolations.push({ path: "project-inputs", reason: "changed-or-missing" });
        } catch (error) {
          detectionViolations.push({ path: "project-inputs",
            reason: error instanceof Error ? error.code || error.name : "read-failed" });
        }
        try {
          const current = await resolveTrustedFixture({
            trustedFixtures, fixtureId: trustedAction.id, projectRoot: root,
          });
          if (current.descriptorSha256 !== trustedAction.descriptorSha256 ||
              !isDeepStrictEqual(current.projectInputs, trustedAction.projectInputs) ||
              current.descriptor.evidenceSeal?.archiveRoot !==
                trustedAction.descriptor.evidenceSeal?.archiveRoot)
            detectionViolations.push({ path: "trusted-project-inputs", reason: "pin-changed" });
        } catch (error) {
          detectionViolations.push({ path: "trusted-project-inputs",
            reason: error instanceof Error ? error.code || error.name : "verification-failed" });
        }
        if (trustedAction.evidenceSeal?.archiveRoot) {
          try {
            const current = await checkedOwner();
            const currentUpstream = await prerequisites(current.value);
            const expected = await trustedEvidenceFiles(current.work, currentUpstream,
              historicPaths, trustedAction.projectInputs, { external: true });
            if (!isDeepStrictEqual(expected, reservedTrustedFiles))
              detectionViolations.push({ path: "accepted-evidence", reason: "hashes-changed" });
          } catch (error) {
            detectionViolations.push({ path: "accepted-evidence",
              reason: error instanceof Error ? error.code || error.name : "verification-failed" });
          }
        }
        for (const [file, expected] of Object.entries(trustedBaseline)) {
          try {
            const full = path.join(root, relative(file));
            const stat = await lstat(full);
            if (expected === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
                stat.size > 32 * 1024 * 1024 ||
                hash(await readFile(full)) !== expected)
              detectionViolations.push({ path: file, reason: "changed-or-created" });
          } catch (error) {
            if (error instanceof Error && error.code === "ENOENT") {
              if (expected !== null) detectionViolations.push({ path: file, reason: "missing" });
            } else detectionViolations.push({ path: file,
              reason: error instanceof Error ? error.code || error.name : "read-failed" });
          }
        }
        try {
          await verifyArtifactArchives(work);
          const current = await prerequisites(await issue(id));
          if (!isDeepStrictEqual(upstream.receipts, current.receipts))
            detectionViolations.push({ path: "prerequisites", reason: "receipt-changed" });
          if (upstream.retainedEvidence.length)
            await verifyRetainedEvidence(upstream.retainedEvidence, started + budgetMs);
        } catch (error) {
          detectionViolations.push({ path: "accepted-evidence", reason:
            error instanceof WorkError ? error.code : error.name });
        }
        passed &&= detectionViolations.length === 0 && cleanupErrors.length === 0 &&
          verifierResult === "passed";
      }
      if (trustedAction && trustedSealFailed)
        detectionViolations.push({ path: "evidence-seal", reason: "verification-failed" });
      if (passed) {
        try {
          passed = JSON.stringify(sources) === JSON.stringify(await fingerprint(proofPaths));
          if (isolationException || evidence) {
            await verifyArtifactArchives(work);
            const current = await prerequisites(await issue(id));
            passed &&= isDeepStrictEqual(upstream.receipts, current.receipts);
          }
          if (allEvidence.length) await verifyRetainedEvidence(allEvidence, started + budgetMs);
        }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          primaryError = error;
          passed = false;
          if (trustedAction)
            detectionViolations.push({ path: "post-cleanup-verification", reason: error.code || error.name });
        }
      }
      let platformProof;
      if (passed && (work.fixture?.stage === "first-case" ||
          (trustedAction && trustedAction.checkFirstCase))) {
        try {
          let visualEvidence = [];
          if (trustedAction && work.fixture?.visual) {
            const outputs = await fingerprint([trustedAction.outputDirectory], { includeIgnored: true });
            visualEvidence = Object.keys(outputs).filter(file => file.endsWith(".png") && outputs[file] !== null);
            if (visualEvidence.length > 16)
              throw new WorkError("fixture-evidence", "Trusted first-case output contains more than 16 PNG artifacts.");
          }
          platformProof = await firstCaseEvidence(trustedAction ? {
            report: trustedAction.report,
            observationDirectory: trustedAction.observationDirectory,
            visualEvidence,
          } : firstCase, work.fixture || { visual: false }, run);
          if (trustedAction) {
            for (const [file, expected] of Object.entries(trustedAction.firstCaseBaseline)) {
              const full = path.join(root, relative(file));
              const stat = await lstat(full);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
                  stat.size > 32 * 1024 * 1024)
                throw new WorkError("trusted-fixture-evidence", "Accepted first-case evidence is missing, oversized or aliased: " + file);
              const actual = hash(await readFile(full));
              if (actual !== expected)
                throw new WorkError("trusted-fixture-evidence", "Trusted fixture changed accepted first-case evidence: " + file);
            }
          }
          if (Object.keys(platformProof.firstCase.artifacts).some(file => historicPaths.includes(file)))
            throw new WorkError("fixture-evidence", "Refreshed first-case evidence cannot reuse archived artifact paths.");
        }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          primaryError = error;
          passed = false;
          if (trustedAction)
            detectionViolations.push({ path: "first-case-evidence", reason: error.code || error.name });
        }
      }
      if (trustedAction)
        context.phase("filesystem-isolation", "detection-only", {
          filesystemIsolation: false, detectionOnly: true,
          trustedFixture: trustedFixture, verifier: verifierResult,
          ...(trustedAction.evidenceSeal && { evidenceSeal: trustedAction.evidenceSeal }),
          violations: detectionViolations,
        });
      context.setPrimary({ passed, error: primaryError, ...(evidence && { kind: "retained-evidence" }) });
      const trustedCleanupVerified = cleanupErrors.length === 0 && verifierResult === "passed";
      const terminal = await context.finalize({ cleanupErrors,
        ...(cleanup || trustedAction ? { cleanupVerified:
          trustedAction ? trustedCleanupVerified : cleanupErrors.length === 0 } : {}) });
      const isolation = isolationException
        ? { filesystemIsolation: false, wslFixtureException: isolationException } : {};
      const actionResult = label => terminal.commands.find(command => command.label === label)?.outcome || "not-run";
      const trustedActionReceipt = trustedAction ? {
        filesystemIsolation: false,
        detectionOnly: true,
        id: trustedFixture,
        descriptorSha256: trustedAction.descriptorSha256,
        ...(trustedAction.evidenceSeal && { evidenceSeal: trustedAction.evidenceSeal }),
        projectInputs: trustedAction.projectInputs,
        outputDirectory: trustedAction.outputDirectory,
        baseline: trustedBaseline,
        violations: detectionViolations,
        actions: {
          primary: { executable: trustedAction.descriptor.executable,
            sha256: trustedAction.descriptor.sha256, status: actionResult("trusted-fixture") },
          cleanup: { executable: trustedAction.descriptor.cleanup.executable,
            sha256: trustedAction.descriptor.cleanup.sha256, status: actionResult("trusted-fixture-cleanup") },
          verifier: { executable: trustedAction.descriptor.verifyCleanup.executable,
            sha256: trustedAction.descriptor.verifyCleanup.sha256, status: actionResult("trusted-fixture-independent-verifier") },
        },
        verifier: verifierResult,
        status: terminal.ok ? "complete" : "failed",
      } : undefined;
      let receiptPath = path.relative(root, path.join(context.outputDir, "manifest.json"));
      if (isolationException || trustedAction) {
        try {
          const observation = JSON.parse(await readFile(path.join(root, receiptPath), "utf8"));
          receiptPath = path.relative(root, path.join(context.outputDir,
            trustedAction ? "trusted-fixture-receipt.json" : "wsl-fixture-receipt.json"));
          const receipt = await open(path.join(root, receiptPath), "wx", 0o600);
          try { await receipt.writeFile(JSON.stringify({ ...observation, ...isolation,
            ...(trustedAction ? { filesystemIsolation: false, detectionOnly: true,
              status: terminal.ok ? "complete" : "failed",
              passed: terminal.ok, trustedFixture: trustedActionReceipt } : {}) }) + "\n"); }
          finally { await receipt.close(); }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new WorkError("trusted-fixture-receipt",
            `Could not publish the specialized check receipt: ${error.code || error.name}`, { cause: error });
        }
      }
      const retainedSources = Object.fromEntries(allEvidence.map(file => [file.path, file.sha256]));
      const recordedPaths = [...new Set([...proofPaths, ...(platformProof?.paths || []),
        ...Object.keys(retainedSources)])].sort();
      const recordedSources = Object.fromEntries(Object.entries({
        ...sources, ...(platformProof?.sources || {}), ...retainedSources,
      }).sort(([a], [b]) => a.localeCompare(b)));
      const proof = { paths: recordedPaths, sources: recordedSources, prerequisites: upstream.receipts,
        kind, budgetMs, ...isolation,
        ...(trustedAction ? { filesystemIsolation: false, detectionOnly: true,
          trustedFixture: trustedActionReceipt } : {}),
        ...(evidence && { retainedEvidence: evidence }),
        ...(upstream.retainedEvidence.length && { inheritedRetainedEvidence: upstream.retainedEvidence }),
        ...(platformProof ? { firstCase: platformProof.firstCase } : {}),
        cleanup: trustedAction
          ? trustedCleanupVerified ? "command-verified" : "verification-failed"
          : cleanup ? "command-verified" : "not-requested",
        receipt: { path: receiptPath, sha256: hash(await readFile(path.join(root, receiptPath))) },
        passed: passed && terminal.ok && performance.now() - started < budgetMs,
        checkedAt: new Date().toISOString() };
      const latest = await checkedOwner();
      if (performance.now() - started >= budgetMs) proof.passed = false;
      await update(id, ["--if-assignee", checking, "--if-status", "blocked",
        "--metadata", JSON.stringify({ qrclipWork: { ...latest.work, checked: proof } })], checking);
      if (proof.passed && performance.now() - started >= budgetMs) {
        proof.passed = false;
        await update(id, ["--if-assignee", checking, "--if-status", "blocked",
          "--metadata", JSON.stringify({ qrclipWork: { ...latest.work, checked: proof } })], checking);
      }
      await update(id, ["--if-assignee", checking, "--if-status", "blocked",
        "--assignee", actorFor(attempt), "--status", "in_progress"], checking);
      return proof;
      } catch (error) { await releaseFailedCheck(error); }
    },
    async accept(id, attempt, { review } = {}) {
      const { value, work } = await owned(id, attempt);
      if (work.attempt.coordinator !== actor)
        throw new WorkError("ownership", "Only the coordinating session can accept this work.");
      if (value.status !== "in_progress")
        throw new WorkError("unverified", "Only active work can be accepted.");
      if (work.fixture?.stage === "first-case" &&
          (typeof review !== "string" || !review.trim() || review.length > WORK_INTERFACE.reviewMaxCharacters))
        throw new WorkError("fixture-review", `accept.review must be a nonempty string of at most ${WORK_INTERFACE.reviewMaxCharacters} characters describing coordinator inspection of the executed case and actual artifacts.`);
      // Status alone can go in_progress -> blocked -> in_progress during a
      // newer check. Claim a unique owner, then read the exact proof it protects.
      const accepting = `${actorFor(attempt)}:accept:${randomUUID()}`;
      await update(id, ["--if-assignee", actorFor(attempt), "--if-status", "in_progress",
        "--assignee", accepting, "--status", "blocked"], actorFor(attempt));
      try {
        const latest = await issue(id);
        const current = workData(latest);
        if (latest.assignee !== accepting || current.attempt?.id !== attempt)
          throw new WorkError("ownership", "The acceptance transition is no longer owned.");
        const upstream = await prerequisites(latest);
        if (!current.checked?.passed || !(await fresh(current.checked)))
          throw new WorkError("unverified", "A passing check with unchanged inputs and receipt is required.");
        if (current.fixture?.stage === "first-case" && !current.checked.firstCase)
          throw new WorkError("unverified", "First-case work requires executed platform evidence, not a build-only proof.");
        if (!isDeepStrictEqual(upstream.receipts, current.checked.prerequisites))
          throw new WorkError("unverified", "Prerequisites changed after the check.");
        await update(id, ["--if-assignee", accepting, "--if-status", "blocked",
          "--assignee", actorFor(attempt), "--status", "closed",
          "--metadata", JSON.stringify({ qrclipWork: { ...current, accepted: {
            ...current.checked, ...(current.fixture?.stage === "first-case" ? {
              fixtureReview: { text: review.trim(), actor, reviewedAt: new Date().toISOString() },
            } : {}),
          } } })], accepting);
        return { id, accepted: true };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // Release only this transition. A failed release stays conservatively
        // owned by its unique token and needs explicit observed-owner recovery.
        try {
          await update(id, ["--if-assignee", accepting, "--if-status", "blocked",
            "--assignee", actorFor(attempt), "--status", "in_progress"], accepting);
        } catch (releaseError) {
          if (!(releaseError instanceof Error)) throw releaseError;
          throw new AggregateError([error, releaseError],
            "Acceptance failed and its exclusive owner could not be released; inspect before explicit recovery.");
        }
        throw error;
      }
    },
  };
}
