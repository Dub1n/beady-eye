import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();
const workspace = join(cwd, ".beads");
const args = process.argv.slice(2);
const [sandbox, flag, actor, operation, id, ...options] = args;
if (sandbox !== "--sandbox" || process.env.BEADS_DIR !== workspace)
  throw new Error("The fixture requires a bound local store.");
const valueFor = name => options.includes(name) ? options[options.indexOf(name) + 1] : undefined;
const out = value => process.stdout.write(JSON.stringify(value));
await appendFile(join(workspace, "commands.jsonl"), JSON.stringify(args) + "\n");

if (args.join(" ") === "--sandbox --readonly where --json") {
  out({ schema_version: 1, path: workspace, database_path: join(workspace, "embeddeddolt") });
} else if (flag === "--actor" && /^[a-z0-9.-]+$/.test(id ?? "")) {
  const file = join(workspace, id + ".json");
  const issue = JSON.parse(await readFile(file, "utf8"));
  switch (operation) {
    case "show":
      out([issue]);
      break;
    case "comments":
      out([]);
      break;
    case "update": {
      if (valueFor("--if-assignee") !== issue.assignee || valueFor("--if-status") !== issue.status)
        throw new Error("Fixture state or owner changed before update.");
      if (actor !== issue.assignee)
        throw new Error("The update did not use the reserved actor.");
      if (options.includes("--assignee")) issue.assignee = valueFor("--assignee");
      if (options.includes("--status")) issue.status = valueFor("--status");
      if (options.includes("--metadata")) Object.assign(issue.metadata, JSON.parse(valueFor("--metadata")));
      const partial = file + "." + process.pid;
      await writeFile(partial, JSON.stringify(issue));
      await rename(partial, file);
      out([issue]);
      break;
    }
    default:
      throw new Error(`Unsupported fixture operation: ${operation}`);
  }
} else {
  throw new Error("Invalid fixture invocation.");
}
