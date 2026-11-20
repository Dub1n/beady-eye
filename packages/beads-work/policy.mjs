// allow: SIZE_OK — The transfer scope keeps admission and its binding in this single policy file.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";

const exec = promisify(execFile);
const maxBytes = 64 * 1024;
const loopback = "127.0.0.1";
const levels = new Map(["disabled", "observation", "management", "delegation"]
  .map((level, rank) => [level, rank]));
const scopes = new Set(["all-local", "selected-directories", "explicit-projects"]);
const requiredLevels = new Map([
  ["show", "observation"], ["packet", "observation"], ["limits", "observation"],
  ["observe", "observation"],
  ["create", "management"], ["edit", "management"], ["note", "management"],
  ["check", "management"], ["accept", "management"], ["recover", "management"],
  ["begin", "delegation"], ["receipt", "delegation"],
]);
const issuedBindings = new WeakSet();
const issuedDecisions = new WeakSet();
const prepareLevels = new Map([["direct", "management"], ["delegate", "delegation"]]);

class PolicyError extends Error {
  name = "PolicyError";
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function inspect(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function identity(info) {
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

async function boundedFile(path) {
  // NONBLOCK keeps a replacement FIFO from hanging between lookup and open.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > maxBytes) {
      throw new PolicyError("file", "Expected a bounded, unaliased regular file.");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new PolicyError("file", "File exceeds 64 KiB.");
    return { bytes: bytes.subarray(0, used), identity: identity(info) };
  } finally {
    await file.close();
  }
}

function jsonObject(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("json", "Expected a JSON object.");
  }
  // JSON.parse validates syntax, but leaves only the last value of a duplicate key.
  const objects = [];
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (token[0] === "{") objects.push(new Set());
    else if (token[0] === "}") objects.pop();
    else if (token[1]) {
      const key = JSON.parse(token[0].slice(0, -1));
      const keys = objects.at(-1);
      if (keys.has(key)) throw new PolicyError("json", "Remove duplicate JSON keys.");
      keys.add(key);
    }
  }
  return value;
}

async function trustedFixtureEntries(entries, projectRoot) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries) ||
      Object.keys(entries).length > 32) {
    throw new PolicyError("policy", "Use an object of at most 32 exact trusted fixture grants.");
  }
  const grants = {};
  for (const [id, grant] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
        !grant || typeof grant !== "object" || Array.isArray(grant) ||
        Object.keys(grant).some(key => key !== "descriptor" && key !== "sha256") ||
        Object.keys(grant).length !== 2 || typeof grant.descriptor !== "string" ||
        !isAbsolute(grant.descriptor) || grant.descriptor.includes("\0") ||
        typeof grant.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(grant.sha256)) {
      throw new PolicyError("policy", "Each trusted fixture grant needs an ID, absolute descriptor path and SHA-256.");
    }
    const descriptor = grant.descriptor;
    const fromProject = relative(projectRoot, descriptor);
    if (fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(".." + sep)) ||
        isAbsolute(fromProject) || await realpath(descriptor) !== descriptor) {
      throw new PolicyError("policy", "Trusted fixture descriptors must be canonical absolute files outside their project.");
    }
    const { bytes } = await boundedFile(descriptor);
    if (createHash("sha256").update(bytes).digest("hex") !== grant.sha256) {
      throw new PolicyError("policy", `Trusted fixture descriptor hash does not match grant ${id}.`);
    }
    grants[id] = Object.freeze({ descriptor, sha256: grant.sha256 });
  }
  return Object.keys(grants).length ? Object.freeze(grants) : undefined;
}

async function policyEntries(entries, defaultLevel, allowWslEvidenceChecks = false, allowTrustedFixtures = false) {
  const byRoot = new Map();
  if (!Array.isArray(entries) || entries.length > 128) {
    throw new PolicyError("policy", "Use an array of up to 128 policy roots per section.");
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some(key => key !== "root" && key !== "level" &&
          !(allowWslEvidenceChecks && key === "allowWslEvidenceChecks") &&
          !(allowTrustedFixtures && key === "trustedFixtures")) ||
        (Object.hasOwn(entry, "allowWslEvidenceChecks") && typeof entry.allowWslEvidenceChecks !== "boolean") ||
        typeof entry.root !== "string" || !isAbsolute(entry.root) || entry.root.includes("\0") ||
        !levels.has(Object.hasOwn(entry, "level") ? entry.level : defaultLevel)) {
      throw new PolicyError("policy", "Use absolute directory roots with valid policy levels.");
    }
    const root = await realpath(entry.root);
    if (!(await lstat(root)).isDirectory() || byRoot.has(root)) {
      throw new PolicyError("policy", "Remove duplicate or non-directory policy roots.");
    }
    const fixtures = allowTrustedFixtures && Object.hasOwn(entry, "trustedFixtures")
      ? await trustedFixtureEntries(entry.trustedFixtures, root) : undefined;
    byRoot.set(root, { level: Object.hasOwn(entry, "level") ? entry.level : defaultLevel,
      allowWslEvidenceChecks: allowWslEvidenceChecks && entry.allowWslEvidenceChecks === true,
      ...(fixtures && { trustedFixtures: fixtures }) });
  }
  return byRoot;
}

async function readGrant(policyPath, project) {
  if (!isAbsolute(policyPath)) throw new PolicyError("policy", "Use an absolute trusted policy path.");
  const { bytes } = await boundedFile(join(await realpath(dirname(policyPath)), basename(policyPath)));
  const policy = jsonObject(bytes);
  const { version, scope, defaultLevel, directories = [], projects = [] } = policy;
  if (version !== 1 || !scopes.has(scope) || !levels.has(defaultLevel) ||
      Object.keys(policy).some(key => !["version", "scope", "defaultLevel", "directories", "projects"].includes(key))) {
    throw new PolicyError("policy", "Use a version 1 work policy with a supported scope and default level.");
  }
  const directoryLevels = await policyEntries(directories, defaultLevel);
  const projectLevels = await policyEntries(projects, undefined, true, true);
  if (projectLevels.has(project)) return { ...projectLevels.get(project), source: "project" };
  if (scope !== "explicit-projects") {
    // Walking parents uses path components and encounters the deepest match first.
    for (let dir = project; ; dir = dirname(dir)) {
      if (directoryLevels.has(dir)) return { ...directoryLevels.get(dir), source: "directory" };
      if (dir === dirname(dir)) break;
    }
    if (scope === "all-local") return { level: defaultLevel, source: "default", allowWslEvidenceChecks: false };
  }
  return { level: "disabled", source: "scope", allowWslEvidenceChecks: false,
    reason: "Project is outside the policy scope." };
}

async function projectRoot(cwd) {
  const resolved = await realpath(cwd);
  if (!(await lstat(resolved)).isDirectory()) return null;
  let beadsRoot;
  for (let dir = resolved; ; dir = dirname(dir)) {
    if (await inspect(join(dir, ".git"))) return dir;
    if (!beadsRoot && await inspect(join(dir, ".beads"))) beadsRoot = dir;
    if (dir === dirname(dir)) return beadsRoot ?? null;
  }
}

async function storeSnapshot(project) {
  const beadsDir = join(project, ".beads");
  const workspace = await inspect(beadsDir);
  if (!workspace?.isDirectory() || await realpath(beadsDir) !== beadsDir) {
    throw new PolicyError("store", "Project needs its own real local .beads directory.");
  }
  for (const name of ["redirect", ".env", "routes.jsonl"]) {
    if (await inspect(join(beadsDir, name))) {
      throw new PolicyError("store", "Remove Beads redirects, project .env files or cross-store routes before integration.");
    }
  }
  const metadataPath = join(beadsDir, "metadata.json");
  const metadata = await boundedFile(metadataPath);
  const fields = jsonObject(metadata.bytes);
  const { backend, database, dolt_mode, dolt_database, dolt_data_dir } = fields;
  if (backend !== "dolt" || database !== "dolt" || !["embedded", "server"].includes(dolt_mode) ||
      typeof dolt_database !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(dolt_database) ||
      Object.keys(fields).some(key => key !== key.toLowerCase()) ||
      (dolt_data_dir !== undefined && dolt_data_dir !== "")) {
    throw new PolicyError("store", "Use a supported local Dolt store with the default data location.");
  }
  const databasePath = join(beadsDir, dolt_mode === "embedded" ? "embeddeddolt" : "dolt");
  const doltDir = join(databasePath, dolt_database, ".dolt");
  const noms = join(doltDir, "noms");
  const identities = { [beadsDir]: identity(workspace) };
  for (const dir of [project, databasePath, dirname(doltDir), doltDir, noms]) {
    const info = await lstat(dir, { bigint: true });
    if (!info.isDirectory() || await realpath(dir) !== dir) {
      throw new PolicyError("store", "Beads database directories must be real and stay inside the project.");
    }
    identities[dir] = identity(info);
  }
  const manifest = await lstat(join(noms, "manifest"), { bigint: true });
  if (!manifest.isFile() || manifest.nlink !== 1n) {
    throw new PolicyError("store", "Beads needs an existing local Dolt manifest.");
  }
  for (const path of [metadataPath, join(beadsDir, "config.yaml"), join(beadsDir, "config.local.yaml")]) {
    if (path !== metadataPath && !await inspect(path)) continue;
    const { bytes, identity: key } = path === metadataPath ? metadata : await boundedFile(path);
    identities[path] = `${key}:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  const route = dolt_mode === "server" ? await serverRoute({ beadsDir, fields, noms }) : null;
  return { beadsDir, databasePath, identities: Object.freeze(identities), route };
}

async function serverRoute({ beadsDir, fields, noms }) {
  const { dolt_database: database, dolt_server_host: host = "", dolt_server_port: expectedPort,
    dolt_server_socket: socket = "", dolt_server_user: user = "", dolt_server_tls: tls = false,
    dolt_team_server: team = false, project_id: projectId } = fields;
  if (process.platform !== "linux" || !["", loopback].includes(host) || socket !== "" ||
      !["", "root"].includes(user) || tls !== false || team !== false ||
      typeof projectId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(projectId)) {
    throw new PolicyError("store", "Use a project-owned Linux Dolt server on numeric loopback with local root access.");
  }
  const [pidFile, portFile] = await Promise.all(["pid", "port"]
    .map(name => boundedFile(join(beadsDir, `dolt-server.${name}`))));
  const pidText = pidFile.bytes.toString("utf8").trim();
  const portText = portFile.bytes.toString("utf8").trim();
  const port = Number(portText);
  if (!/^[1-9]\d{0,9}$/.test(pidText) || !/^[1-9]\d{0,4}$/.test(portText) || port > 65535 ||
      (expectedPort !== undefined && expectedPort !== port)) {
    throw new PolicyError("store", "Dolt server PID and port records must agree with the local metadata.");
  }
  return Object.freeze({ database, projectId, port, pid: Number(pidText), noms,
    records: `${pidFile.identity}:${portFile.identity}` });
}

// `bd dolt status` can delete stale state on its managed branch, and its
// no-auto-start branch only pings SQL. Establish ownership without either.
async function serverGeneration(snapshot, env) {
  const { route: { pid, port, noms }, databasePath } = snapshot;
  const proc = `/proc/${pid}`;
  const { stdout } = await exec("/usr/bin/ss", ["-Hlntep", `sport = :${port}`], {
    env, timeout: 1500, maxBuffer: maxBytes, killSignal: "SIGKILL",
  });
  const owner = /^LISTEN\s+\d+\s+\d+\s+127\.0\.0\.1:(\d+)\s+\S+\s+users:\(\("dolt",pid=(\d+),fd=(\d+)\)\)\s+.*/.exec(stdout.trim());
  const inode = /\bino:([1-9]\d*)\b/.exec(stdout);
  if (stdout.trim().includes("\n") || Number(owner?.[1]) !== port || Number(owner?.[2]) !== pid || !inode ||
      await readlink(`${proc}/fd/${owner[3]}`) !== `socket:[${inode[1]}]` ||
      basename(await readlink(`${proc}/exe`)) !== "dolt" || await readlink(`${proc}/cwd`) !== databasePath ||
      identity(await stat(`${proc}/cwd`, { bigint: true })) !== snapshot.identities[databasePath]) {
    throw new PolicyError("store", "Dolt's loopback listener must belong to the project server process.");
  }
  const lockPath = join(noms, "LOCK");
  const lock = await lstat(lockPath, { bigint: true });
  const fds = await readdir(`${proc}/fd`);
  const openLock = lock.isFile() && lock.nlink === 1n && fds.length <= 1024 &&
    (await Promise.all(fds.map(async fd => {
      const path = `${proc}/fd/${fd}`;
      try {
        return await readlink(path) === lockPath &&
          identity(await stat(path, { bigint: true })) === identity(lock);
      } catch (error) {
        if (missing(error)) return false; // A concurrent SQL connection can close its descriptor.
        throw error;
      }
    }))).some(Boolean);
  const processStat = await readFile(`${proc}/stat`, "utf8");
  const startTicks = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
  if (!openLock || !/^[1-9]\d*$/.test(startTicks)) {
    throw new PolicyError("store", "Cannot associate the running Dolt generation with the named local database.");
  }
  return `${pid}:${startTicks}:${inode[1]}`;
}

async function probe(bd, args) {
  const { binary, cwd, env } = bd;
  const { stdout } = await exec(binary, ["--sandbox", "--readonly", ...args, "--json"], {
    cwd, env, timeout: 3000, maxBuffer: maxBytes, killSignal: "SIGKILL", encoding: "buffer",
  });
  return stdout;
}

async function verifyServer(bd, snapshot) {
  const { route, beadsDir } = snapshot;
  // Context is a config-only probe on the classic server path. Do not mask a
  // configured remote host, shared server, or a different resolved port here.
  const context = jsonObject(await probe(bd, ["context"]));
  if (context.schema_version !== 1 || context.bd_version !== "1.3.4" || context.backend !== "dolt" ||
      context.beads_dir !== beadsDir || context.repo_root !== bd.cwd || context.is_redirected !== false ||
      context.dolt_mode !== "server" || context.database !== route.database || context.project_id !== route.projectId ||
      context.server_host !== loopback || context.server_port !== route.port || Object.hasOwn(context, "error")) {
    throw new PolicyError("store", "bd did not report a supported project-local Beads 1.3.4 server route.");
  }
  for (const [key, allowed] of [
    ["dolt.shared-server", ["", "false"]], ["dolt.auto-start", ["", "true"]],
    ["routing.default", ["", "."]], ["routing.mode", ["", "manual"]],
  ]) {
    const config = jsonObject(await probe(bd, ["config", "get", key]));
    if (config.schema_version !== 1 || config.key !== key ||
        config.location !== "config.yaml" || !allowed.includes(config.value)) {
      throw new PolicyError("store", "Shared, externally managed and cross-project Beads routes are unsupported.");
    }
  }
  return serverGeneration(snapshot, bd.env);
}

export async function assertWorkBinding(binding) {
  if (!issuedBindings.has(binding)) throw new PolicyError("binding", "An admitted work binding is required.");
  try {
    const live = await storeSnapshot(binding.project);
    if (JSON.stringify(live.identities) === JSON.stringify(binding.identities) &&
        JSON.stringify(live.route) === JSON.stringify(binding.route) &&
        (!live.route || await verifyServer(binding.discovery, live) === binding.generation)) return;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  throw new PolicyError("binding", "Project or Beads store binding changed. Stop work and review the original store.");
}

export async function evaluateWorkPolicy({ cwd, policyPath, binary = "bd", requestLevel }) {
  let project = null;
  let source = "boundary";
  try {
    project = await projectRoot(cwd);
    if (project === null) throw new PolicyError("boundary", "No Git checkout or Beads workspace contains the working directory.");
    source = "policy";
    const grant = await readGrant(policyPath, project);
    if (requestLevel !== undefined && !levels.has(requestLevel)) {
      throw new PolicyError("policy", "Use a supported requested capability.");
    }
    if (grant.level === "disabled") {
      return { project, level: grant.level, source: grant.source, allowWslEvidenceChecks: false,
        reason: grant.reason ?? "Work is disabled by the user policy." };
    }
    if (requestLevel === "disabled") {
      return { project, level: "disabled", source: "request", allowWslEvidenceChecks: false,
        reason: "Work is disabled by the requested capability." };
    }
    source = "store";
    const snapshot = await storeSnapshot(project);
    // Only pass runtime variables needed by bd. The caller's storage and Git
    // routing environment, shell PWD, credentials and telemetry are not inherited.
    const env = Object.freeze({
      ...Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "USER", "TMPDIR", "LANG"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      PATH: (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter) || "/usr/bin:/bin",
      BEADS_DIR: snapshot.beadsDir, BEADS_DOLT_AUTO_START: "0",
      BEADS_DOLT_SHARED_SERVER: "false",
      ...(!snapshot.route && { BD_DOLT_SHARED_SERVER: "false" }),
      BD_DISABLE_METRICS: "1", BD_NO_HOOKS: "true", GIT_MASTER: "1",
    });
    const discovery = Object.freeze({ binary, cwd: project, env });
    if (snapshot.route) {
      const version = jsonObject(await probe(discovery, ["version"]));
      if (version.schema_version !== 1 || version.version !== "1.3.4" ||
          version.commit !== "7ef2fd05eb0cd3bdbde051f93cfc14ccf270cdde") {
        throw new PolicyError("store", "Use the supported Beads 1.3.4 build for a local Dolt server.");
      }
    }
    const location = jsonObject(await probe(discovery, ["where"]));
    if (location.schema_version !== 1 || location.path !== snapshot.beadsDir ||
        location.database_path !== snapshot.databasePath ||
        ["error", "redirected_from"].some(key => Object.hasOwn(location, key))) {
      throw new PolicyError("store", "bd did not report one unredirected local workspace and database.");
    }
    const generation = snapshot.route ? await verifyServer(discovery, snapshot) : null;
    const operationEnv = snapshot.route ? Object.freeze({ ...env,
      BD_DOLT_AUTO_START: "false", BD_DOLT_SHARED_SERVER: "false",
      BD_ROUTING_MODE: "manual", BD_ROUTING_DEFAULT: ".",
      BEADS_DOLT_SERVER_HOST: loopback, BEADS_DOLT_SERVER_PORT: String(snapshot.route.port),
      BEADS_DOLT_SERVER_DATABASE: snapshot.route.database,
    }) : env;
    if (snapshot.route) {
      // Strict --readonly prevents maintenance and migrations. The SQL read
      // uses the same route and environment as the admitted tracker calls.
      const rows = JSON.parse((await probe({ ...discovery, env: operationEnv }, ["sql", `
        SELECT value AS project_id FROM metadata WHERE \`key\` = '_project_id'
        AND NOT EXISTS (SELECT 1 FROM config WHERE
          (\`key\` = 'routing.default' AND TRIM(value) NOT IN ('', '.')) OR
          (\`key\` = 'routing.mode' AND TRIM(value) NOT IN ('', 'manual')) OR
          (\`key\` = 'contributor.auto_route' AND TRIM(value) = 'true'))
      `])).toString("utf8"));
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.project_id !== snapshot.route.projectId) {
        throw new PolicyError("store", "The local Dolt database did not confirm the project's identity and routing.");
      }
    }
    const binding = Object.freeze({ project, ...snapshot, discovery, generation, env: operationEnv });
    issuedBindings.add(binding);
    await assertWorkBinding(binding);
    const clamped = requestLevel !== undefined && levels.get(requestLevel) < levels.get(grant.level);
    const decisionValue = { project, level: clamped ? requestLevel : grant.level,
      source: clamped ? "request" : grant.source, allowWslEvidenceChecks: grant.allowWslEvidenceChecks === true,
    };
    if (grant.trustedFixtures) Object.defineProperty(decisionValue, "trustedFixtures", {
      value: grant.trustedFixtures,
    });
    Object.defineProperty(decisionValue, "binding", { value: binding });
    const decision = Object.freeze(decisionValue);
    issuedDecisions.add(decision);
    return decision;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reason = error instanceof PolicyError && error.code === source ? error.message : {
      boundary: "Cannot resolve the project boundary from the working directory.",
      policy: missing(error) ? "Work policy or a configured root is missing. Check the trusted policy and its roots."
        : "Cannot read a valid bounded work policy. Check its permissions, JSON and roots.",
      store: "Cannot verify the local Beads store. Check its files and the installed bd where command.",
    }[source];
    return { project, level: "disabled", source, reason };
  }
}

export function requireWorkCapability(decision, operation, { mode = "delegate" } = {}) {
  if (operation === "policy") return;
  const required = operation === "prepare"
    ? prepareLevels.get(mode)
    : requiredLevels.get(operation);
  if (!required) throw new PolicyError("operation", "Unsupported work operation or prepare mode.");
  if (!issuedDecisions.has(decision) || levels.get(decision.level) < levels.get(required)) {
    throw new PolicyError("capability", `Work requires ${required}. ${decision.reason ?? `Effective level is ${decision.level}.`}`);
  }
}
