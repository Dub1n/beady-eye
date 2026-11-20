import { Type } from "typebox";
import { registerDispatch } from "./dispatch.mjs";
import { registerWorkTool } from "./tool.mjs";
import { registerSession } from "./session.mjs";

const registered = new WeakSet();

export default function (pi) {
  if (registered.has(pi)) return;
  registered.add(pi);
  const session = registerSession(pi);
  registerWorkTool(pi, Type, session);
  registerDispatch(pi, session);
}
