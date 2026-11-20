import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const readableLevels = new Set(["observation", "management", "delegation"]);

export async function bindWorkPolicy(executable, projectDirectory, taskDirectory) {
  if (!isAbsolute(executable) || !isAbsolute(projectDirectory)) return null;
  const [project, tasks] = await Promise.all([realpath(projectDirectory), realpath(taskDirectory)]);
  const pending = new Map();
  async function permitted(cwd) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
    const active = pending.get(cwd);
    if (active) return active;
    const decision = (async () => {
      try {
        const { stdout } = await exec(executable, ["policy"], {
          cwd, timeout: 4000, maxBuffer: 8192, killSignal: "SIGKILL",
        });
        const result = JSON.parse(stdout);
        return result?.version === 1 && result.project === project && readableLevels.has(result.level);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return false;
      }
    })();
    pending.set(cwd, decision);
    try {
      return await decision;
    } finally {
      pending.delete(cwd);
    }
  }
  return { taskDirectory: tasks, permitted };
}
