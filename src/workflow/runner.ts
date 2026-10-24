import type { ProviderSettings } from "../config.js";
import { createExperimentRuntime, type ExperimentRuntime } from "../ditto/runtime.js";
import { createTaskMemory } from "../ditto/task-memory.js";
import { createBenchmarkTools, closeBenchmarkTools } from "../ditto/benchmark-tools.js";
import { currentTimeBudgetSignal } from "../execution/time-budget.js";
import { hasCapabilities } from "./capability-schema.js";
import { WorkflowExecutor } from "./executor.js";

/** One shared provider gate, fresh Memory/tools for each capability workflow attempt. */
export function createWorkflowRunner(experiment: ExperimentRuntime, settings: ProviderSettings): Pick<WorkflowExecutor, "run"> {
  const basic = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  return { async run(plan, task, signal) {
    signal = signal ?? currentTimeBudgetSignal();
    if (!hasCapabilities(plan.nodes)) return basic.run(plan, task, signal);
    const tools = createBenchmarkTools();
    const scoped = createExperimentRuntime(settings, { provider: experiment.provider, managedProvider: true, tools, memory: createTaskMemory() });
    try { return await new WorkflowExecutor(scoped.runtime, scoped.providerName, scoped.model).run(plan, task, signal); }
    finally { try { await scoped.close(); } finally { await closeBenchmarkTools(tools); } }
  } };
}
