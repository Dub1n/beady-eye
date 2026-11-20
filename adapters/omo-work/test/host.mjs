import { registerHooks } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// OmO supplies TypeBox to extension imports. Model the host resolver here so
// Node loads the actual package entry without requiring an OmO installation.
const schema = "data:text/javascript," + encodeURIComponent(`export const Type = {
  Object: properties => ({ type: "object", properties }),
  Union: anyOf => ({ anyOf }), Literal: value => ({ const: value }),
  String: options => ({ type: "string", ...options })
};`);
const entry = new URL("../index.mjs", import.meta.url);
const resolver = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "typebox" && context.parentURL === entry.href)
      return { url: schema, shortCircuit: true };
    return next(specifier, context);
  },
});
const { default: load } = await import(entry.href).finally(() => resolver.deregister());
const fakeBd = fileURLToPath(new URL("./mock-bd.mjs", import.meta.url));

export const actor = "fixture-session-coordinator";
export const primary = "smt-4kd3p.1";
export const secondary = "smt-4kd3p.2";
export const attempt = "ccec4a9e-bca0-4ed5-9d9d-ea161aa82071";
export const attempt2 = "ccec4a9e-bca0-4ed5-9d9d-ea161aa82072";

export function prompt(id = primary, prepared = attempt) {
  return `[QRCLIP_WORK ${id} ${prepared}]\nInvented task.`;
}

export function task(input, toolCallId = "call_fixture") {
  return { type: "tool_call", toolName: "task", toolCallId, input };
}

export function host({ record = () => {} } = {}) {
  const hooks = new Map();
  const tools = [];
  const entries = [];
  const pi = {
    on(name, handler) {
      if (hooks.has(name)) throw new Error(`Duplicate hook: ${name}`);
      hooks.set(name, handler);
    },
    registerTool: tool => tools.push(tool),
    appendEntry(customType, data) {
      record(customType);
      entries.push({ type: "custom", customType, data });
    },
  };
  load(pi);
  return { pi, entries, tools, reload: () => load(pi),
    emit: (event, ctx) => hooks.get(event.type)(event, ctx),
    ctx: (cwd, session = actor, branch = entries) => ({ cwd, sessionManager: {
      getSessionId: () => session,
      getFullBranch: () => branch,
    } }) };
}

export async function sandbox(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bdi-omo-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, ".config", "beady-eye");
  await mkdir(config, { recursive: true });
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "bd"), `#!${process.execPath}\nawait import(${JSON.stringify(fakeBd)});\n`,
    { mode: 0o700 });
  for (const [key, value] of Object.entries({
    HOME: root, PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    BDI_WORK_POLICY: join(root, "unused-policy.json"),
    QRCLIP_BEADS_BINARY: join(root, "unused-tracker"),
    BEADS_DIR: join(root, "redirected-tracker"),
    QRCLIP_AGENT_SESSION: "invented-environment-actor",
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }

  return {
    async policy(projects) {
      const pending = join(config, "next-policy");
      await writeFile(pending, JSON.stringify({ version: 1, scope: "explicit-projects",
        defaultLevel: "disabled", projects }));
      await rename(pending, join(config, "work-policy.json"));
    },
    async project(name, { store = true } = {}) {
      const cwd = join(root, name);
      const workspace = join(cwd, ".beads");
      await mkdir(join(cwd, ".git"), { recursive: true });
      if (store) {
        const noms = join(workspace, "embeddeddolt", "grove", ".dolt", "noms");
        await mkdir(noms, { recursive: true });
        await writeFile(join(noms, "manifest"), "invented manifest");
        await writeFile(join(workspace, "metadata.json"), JSON.stringify({
          database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "grove",
        }));
        await writeFile(join(workspace, "commands.jsonl"), "");
      }
      const save = issue => writeFile(join(workspace, issue.id + ".json"), JSON.stringify(issue));
      return { cwd, workspace, save,
        issue: async (id = primary) => JSON.parse(await readFile(join(workspace, id + ".json"), "utf8")),
        calls: async () => (await readFile(join(workspace, "commands.jsonl"), "utf8"))
          .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
        prepare: (id = primary, prepared = attempt, coordinator = actor) => save({
          id, status: "hooked", assignee: `omo:${prepared}`, title: name,
          metadata: { qrclipWork: { version: 1, paths: [],
            attempt: { id: prepared, coordinator, mode: "delegate", sources: {}, prerequisites: {} } } },
        }) };
    },
  };
}

export const launch = (h, ctx) => h.emit({ type: "session_start", reason: "startup" }, ctx);

export const result = (event, details, isError = false) => ({ ...event, type: "tool_result",
  content: [{ type: "text", text: "Native task result." }], details, isError });

export const execute = (h, ctx, operation, input = {}) => h.tools[0].execute("work-tool",
  { operation, input: JSON.stringify(input) }, undefined, undefined, ctx);
