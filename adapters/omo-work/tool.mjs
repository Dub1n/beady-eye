import { WorkError, WORK_INTERFACE } from "../../packages/beads-work/agent-work.mjs";
import { runWorkCommand } from "../../packages/beads-work/agent-work-cli.mjs";
import { requireWorkCapability } from "../../packages/beads-work/policy.mjs";

const operations = new Set(["create", "show", "packet", "limits", "edit", "note",
  "prepare", "check", "accept", "recover"]);

export function registerWorkTool(pi, Type, session) {
  pi.registerTool({
    name: "beads_work", label: "Beads work",
    description: [
      "Authoritative local Beads tracker, subject to the user's current project policy.",
      "JSON input: create {title,objective,paths,blockedBy?,acceptance?,parent?,labels?,type?,fixture?};",
      "show/packet {id}; limits {} exposes history, fixture, recovery and deadline contracts;",
      "edit {id,title?,objective?,acceptance?,fixture?} or organization-only {id,parent?,labels?};",
      `note {id,kind:${WORK_INTERFACE.noteKinds.join("|")},text,source?,observedAt?};`,
      "prepare {id,mode?:direct|delegate,name?}; check {id,attempt,command,args,budgetMs?,kind?:measurement|functional,expectedExitCodes?,cleanup?:{command,args},firstCase?:{report,visualEvidence,manifest?,observationDirectory?},outputDirectories?:string[]};",
      `accept {id,attempt,review?:string}; recover {id,assignee:string|null,status,reason,confirmedStopped:true,operation?:${WORK_INTERFACE.recoveryOperations.join("|")}}.`,
      `Verify recoveryContractVersion:${WORK_INTERFACE.recoveryContractVersion} through the loaded tool.`,
      "refresh-first-case requires original accepted receipt/report/observation/PNG bytes intact, retains additional copies and original-to-retained mappings, and records an atomic qrclipWork.refresh marker.",
      "Resume a stopped blocked refresh explicitly with its observed owner. Generic recovery cannot discard accepted proof. Durable archive comments are reconciled across interruption, then fresh execution and review are required.",
      "Original artifact and receipt paths and archive copies remain immutable. Retention uses a 16 MiB fingerprint batch limit and at most 19 managed artifact files per proof. Archives do not expire automatically.",
      "Protected check commands and cleanup require an available Linux bubblewrap read-only host filesystem view with dropped capabilities, private /tmp and writable binds only for explicitly fresh output trees. Missing isolation fails closed before either command.",
      "Separately, an operator-approved named trusted fixture uses check {id,attempt,kind:'functional',trustedFixture:'fixture-id',budgetMs?}. This mode detects evidence damage after cleanup; it does not prevent or repair it. The request may not supply replacement command, args, environment, or cleanup. Check limits for trustedFixtureCheckVersion before use.",
      "On WSL, an exact trusted project opt-in allows only a built-in retained-evidence check for a protected non-fixture item: check {id,attempt,kind:'functional',budgetMs?,retainedEvidence:[{path,sha256,completeManifest?:true}]}. The direct preparing coordinator supplies no executable, cleanup or output directories. This does not run a new platform check.",
      "Protected first cases require manifest or observationDirectory. The directory must exist empty and disjoint from historical evidence before execution. The report-bound nested manifest is discovered and validated afterward. An explicit manifest must match the report.",
      "Ordinary first cases may use {report,visualEvidence}. At most 16 additional outputDirectories are allowed. Writable trees cannot contain .beads, protected paths or parents, symlinks or hard-link aliases.",
      "The view constrains descendants. Stopped-owner confirmation and serialized resources remain required. Contract edits and preparation use unique CAS reservations and reread protected metadata.",
      "cancel-expansion permits open/unassigned/no-attempt or hooked delegate work with no dispatch, check or receipt. Normal guarded closure creates no accepted proof. All Beads blockers and children must be closed.",
      "Cancel before reopening the first case. No forced closure or dependency removal. Supply assignee:null for open cancellation.",
      `Measurement is capped at ${WORK_INTERFACE.measurementMaxMs / 1000}s and functional checks at ${WORK_INTERFACE.functionalMaxMs / 1000}s.`,
      "fixture is {stage:'first-case',visual:boolean} or {stage:'expansion',firstCase:id}. First-case acceptance requires executed evidence and coordinator review. Expansion requires accepted first-case proof.",
      "Does not start or retry the database or dispatch work.",
    ].join(" "),
    parameters: Type.Object({
      operation: Type.Union([...operations].map(value => Type.Literal(value))),
      input: Type.String({ maxLength: 32_000 }),
    }),
    async execute(_id, { operation, input }, _signal, _update, ctx) {
      if (!operations.has(operation)) throw new WorkError("operation", "Unknown public work operation.");
      if (typeof input !== "string" || Buffer.byteLength(input) > 32_000)
        throw new WorkError("input", "Supply one bounded JSON object.");
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new WorkError("input", "input must encode a JSON object.");
      const scope = await session.decide(ctx);
      requireWorkCapability(scope.decision, operation, { mode: parsed.mode });
      await session.verify(scope, ctx);
      const value = await runWorkCommand(session.tracker(scope, ctx), operation, parsed);
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
}
