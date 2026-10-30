import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import { AUTOMATION_TOOLS, automationScope } from "../benchmark/automation.js";

/** Task-local official simulated APIs, dispatched through real Interaction Nodes. */
export function createAutomationTools(): readonly RegisteredTool[] {
  const session = automationScope.getStore();
  if (!session) return [];
  return session.tools.map((descriptor): RegisteredTool => {
    const name = descriptor.name;
    if (!AUTOMATION_TOOLS.includes(name as typeof AUTOMATION_TOOLS[number])) throw new Error("Undeclared official Automation tool");
    return ({
    name,
    description: descriptor.description ?? `Official AutomationBench ${name}`,
    inputSchema: descriptor.inputSchema as JsonObject,
    effects: name === "api_fetch" ? ["read", "write"] : ["read"],
    validate(args) {
      if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Official tool arguments must be an object');
      // Domain field errors are returned as observations by session.call before
      // effects; an internal environment exception still invalidates the world.
    },
    async execute(args) {
      if (automationScope.getStore() !== session) throw new Error("Automation tool invoked outside its task world");
      session.assertHealthy();
      const result = await session.call(name, args);
      return { status: "success", content: result.content };
    },
  }); });
}
