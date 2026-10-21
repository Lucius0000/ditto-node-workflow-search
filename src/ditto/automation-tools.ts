import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { AUTOMATION_TOOLS, automationScope } from "../benchmark/automation.js";

/** Task-local official simulated APIs, dispatched through real Interaction Nodes. */
export function createAutomationTools(): readonly RegisteredTool[] {
  return AUTOMATION_TOOLS.map((name): RegisteredTool => ({
    name,
    description: `Official AutomationBench ${name}`,
    inputSchema: { type: "object" },
    effects: name === "api_fetch" ? ["read", "write"] : ["read"],
    validate() { /* Official schemas and argument validation belong to the task session. */ },
    async execute(args) {
      const session = automationScope.getStore();
      if (!session) throw new Error("Automation tool invoked outside a task world");
      session.assertHealthy();
      const result = await session.call(name, args);
      return { status: "success", content: result.content };
    },
  }));
}
