import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertWorkBinding, evaluateWorkPolicy } from "../policy.mjs";

const exec = promisify(execFile);

test("an existing project-owned Dolt server grants work only for its current route and generation",
  { skip: process.platform !== "linux", timeout: 50_000 }, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "work-policy-server-"));
    const project = join(root, "orchard");
    const home = join(root, "home");
    const policyPath = join(root, "work-policy.json");
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, "config"),
      PATH: (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter),
      BD_DISABLE_METRICS: "1", GIT_MASTER: "1", GIT_CONFIG_NOSYSTEM: "1" };
    const run = (args, overrides = {}) => exec("bd", args, {
      cwd: project, env: { ...env, ...overrides }, timeout: 8_000, killSignal: "SIGKILL",
    });
    const beads = join(project, ".beads");
    const pidPath = join(beads, "dolt-server.pid");
    const portPath = join(beads, "dolt-server.port");
    const metadataPath = join(beads, "metadata.json");
    const configPath = join(beads, "config.yaml");
    const localPid = async () => {
      const pid = (await readFile(pidPath, "utf8")).trim();
      assert.match(pid, /^[1-9]\d*$/);
      assert.equal(await readlink(`/proc/${pid}/cwd`), join(beads, "dolt"));
      assert.match(await readlink(`/proc/${pid}/exe`), /\/dolt$/);
      return pid;
    };
    const stop = async () => {
      const pid = await localPid();
      await run(["--sandbox", "dolt", "stop"]);
      await assert.rejects(readlink(`/proc/${pid}/cwd`), { code: "ENOENT" });
    };
    t.after(async () => {
      if (await access(pidPath).then(() => true, error => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) await stop();
      await rm(root, { recursive: true });
    });

    await mkdir(project);
    await mkdir(home);
    await writeFile(policyPath, JSON.stringify({
      version: 1, scope: "explicit-projects", defaultLevel: "disabled",
      projects: [{ root: project, level: "management" }],
    }));
    await run(["--sandbox", "init", "--server", "--non-interactive", "--skip-agents", "--skip-hooks", "-p", "grove"]);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const pidText = await readFile(pidPath, "utf8");
    const portText = await readFile(portPath, "utf8");
    const port = Number(portText);
    // This matches a managed server with an explicit metadata port, as opposed to
    // letting the fixture exercise only freshly initialized dynamic-port metadata.
    await writeFile(metadataPath, JSON.stringify({ ...metadata, dolt_server_port: port }));
    const config = await readFile(configPath, "utf8");
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    Object.assign(process.env, env);
    const evaluate = () => evaluateWorkPolicy({ cwd: project, policyPath });
    const decision = await evaluate();
    assert.equal(decision.level, "management", decision.reason);
    await assertWorkBinding(decision.binding);
    const { stdout } = await run(["--sandbox", "create", "Invented orchard task", "--json"], decision.binding.env);
    assert.match(JSON.parse(stdout).id, /^grove-/);
    await assertWorkBinding(decision.binding);

    for (const [label, mutate, restore] of [
      ["remote host", () => writeFile(metadataPath, JSON.stringify({
        ...metadata, dolt_server_port: port, dolt_server_host: "192.0.2.1",
      })), () => writeFile(metadataPath, JSON.stringify({ ...metadata, dolt_server_port: port }))],
      ["project shared routing", () => writeFile(configPath, "dolt:\n  shared-server: true\n"),
        () => writeFile(configPath, config)],
      ["explicit external lifecycle", () => writeFile(configPath, "dolt:\n  auto-start: false\n"),
        () => writeFile(configPath, config)],
      ["cross-project creation route", () => writeFile(configPath, "routing:\n  default: ../elsewhere\n"),
        () => writeFile(configPath, config)],
      ["foreign PID on the correct port", () => writeFile(pidPath, `${process.pid}\n`),
        () => writeFile(pidPath, pidText)],
      ["local port disagreement", () => writeFile(portPath, "1\n"), () => writeFile(portPath, portText)],
      ["redirect", () => writeFile(join(beads, "redirect"), "../elsewhere\n"), () => rm(join(beads, "redirect"))],
    ]) {
      await mutate();
      try {
        const denied = await evaluate();
        assert.deepEqual([denied.level, denied.source], ["disabled", "store"], label);
        await assert.rejects(assertWorkBinding(decision.binding), { code: "binding" }, label);
      } finally {
        await restore();
      }
    }
    const beforeStop = await evaluate();
    assert.equal(beforeStop.level, "management", beforeStop.reason);
    await stop();
    const stopped = await evaluate();
    assert.deepEqual([stopped.level, stopped.source], ["disabled", "store"]);
    await assert.rejects(assertWorkBinding(beforeStop.binding), { code: "binding" });
    await assert.rejects(access(pidPath), { code: "ENOENT" });
    await assert.rejects(run(["--sandbox", "show", JSON.parse(stdout).id, "--json"], beforeStop.binding.env));
    await assert.rejects(access(pidPath), { code: "ENOENT" });
    await run(["--sandbox", "dolt", "start"]);
    assert.equal(Number(await readFile(portPath, "utf8")), port);
    assert.notEqual(await localPid(), pidText.trim());
    const replacement = await evaluate();
    assert.equal(replacement.level, "management", replacement.reason);
    await assert.rejects(assertWorkBinding(beforeStop.binding), { code: "binding" });
  });
