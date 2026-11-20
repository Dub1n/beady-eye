import { WorkError } from "./agent-work.mjs";

export async function runWorkCommand(tracker, operation, input) {
  const { id, attempt, ...options } = input;
  switch (operation) {
    case "create": return tracker.create(options);
    case "show": return tracker.issue(id);
    case "packet": return tracker.packet(id);
    case "limits": return tracker.limits();
    case "edit": return tracker.edit(id, options);
    case "note": return tracker.note(id, options);
    case "prepare": return tracker.prepare(id, options);
    case "begin": return tracker.beginDispatch(id, attempt);
    case "receipt": return tracker.dispatched(id, attempt, options);
    case "check": return tracker.check(id, attempt, options);
    case "accept": return tracker.accept(id, attempt, options);
    case "recover": return tracker.recover(id, options);
    default: throw new WorkError("operation", "Unknown work operation: " + operation);
  }
}
