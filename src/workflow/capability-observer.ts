import { AsyncLocalStorage } from "node:async_hooks";
import type { NodeType } from "@codesoul-co/ditto/contracts";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";

export interface CapabilityCompletion {
  readonly nodeType: NodeType;
  readonly graphId: string;
  readonly nodeId: string;
  readonly output: unknown;
}

const completions = new AsyncLocalStorage<(event: CapabilityCompletion) => void>();

/** Each concurrent workflow owns its completion ledger; nested calls retain that scope. */
export function captureCapabilityOutputs<T>(
  onComplete: (event: CapabilityCompletion) => void,
  operation: () => Promise<T>,
): Promise<T> {
  return completions.run(onComplete, operation);
}

/** Observe public Worker execution without changing contracts, routing or Graph scheduling. */
export function observeCapabilityWorkers(workers: readonly WorkerDefinition[]): WorkerDefinition[] {
  return workers.map(worker => ({
    ...worker,
    instantiate() {
      const executor = worker.instantiate();
      return {
        async execute(node, input, context) {
          const output = await executor.execute(node, input, context);
          const scope = context.execution;
          if (scope) completions.getStore()?.({ nodeType: node, graphId: scope.graphId, nodeId: scope.nodeId, output });
          return output;
        },
        ...(executor.dispose ? { dispose: () => executor.dispose!() } : {}),
      };
    },
  }));
}
