#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { createWorkTracker, WorkError } from "./agent-work.mjs";
import { runWorkCommand } from "./agent-work-cli.mjs";
import { assertWorkBinding, evaluateWorkPolicy, requireWorkCapability } from "./policy.mjs";

const defaultPolicy = path.join(os.homedir(), ".config", "beady-eye", "work-policy.json");
const commands = new Set(["create", "show", "packet", "limits", "edit", "note",
  "prepare", "check", "accept", "recover"]);

try {
  const [operation, json, ...rest] = process.argv.slice(2);
  if (!operation || operation === "--help") {
    console.log("Usage: bdi-beads-work policy | <create|show|packet|limits|edit|note|prepare|check|accept|recover> '{}'");
  } else {
    const policyPath = process.env.BDI_WORK_POLICY ?? defaultPolicy;
    if (!path.isAbsolute(policyPath))
      throw new WorkError("policy", "The user policy path must be absolute.");
    if (operation === "policy") {
      if (json !== undefined) throw new WorkError("input", "Policy inspection takes no arguments.");
      const { project, level, source, reason, allowWslEvidenceChecks, trustedFixtures } = await evaluateWorkPolicy({
        cwd: process.cwd(), policyPath, binary: "bd",
      });
      console.log(JSON.stringify({ version: 1, project, level, source, reason,
        ...(allowWslEvidenceChecks && { allowWslEvidenceChecks }),
        ...(Object.keys(trustedFixtures ?? {}).length && { trustedFixtures: Object.keys(trustedFixtures).sort() }) }));
    } else {
      if (!commands.has(operation)) throw new WorkError("operation", "Unknown public work operation.");
      if (!json || Buffer.byteLength(json) > 32_000 || rest.length)
        throw new WorkError("input", "Supply one bounded JSON object.");
      const input = JSON.parse(json);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new WorkError("input", "Supply one JSON object.");
      const decision = await evaluateWorkPolicy({ cwd: process.cwd(), policyPath, binary: "bd" });
      requireWorkCapability(decision, operation, { mode: input.mode ?? "delegate" });
      const tracker = createWorkTracker({
        cwd: decision.project,
        actor: process.env.QRCLIP_AGENT_SESSION ?? process.env.PI_SESSION_ID,
        env: decision.binding.env,
        allowWslEvidenceChecks: decision.allowWslEvidenceChecks === true,
        ...(decision.trustedFixtures && { trustedFixtures: decision.trustedFixtures }),
        beforeCall: () => assertWorkBinding(decision.binding),
      });
      console.log(JSON.stringify(await runWorkCommand(tracker, operation, input)));
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  const code = typeof error.code === "string" ? error.code : "failed";
  console.error(JSON.stringify({ code, error: error.message.slice(0, 1000) }));
  process.exitCode = 1;
}
