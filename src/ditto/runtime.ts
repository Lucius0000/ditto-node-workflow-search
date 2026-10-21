import { withReflectionFormatRepair } from "./reflection-format.js";
import { budgetOutputBoundary } from "./budget-output.js";
import { appendFile } from "node:fs/promises";
import { createDitto, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createHttpProvider, createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createMemoryWorker, type MemoryResources } from "@codesoul-co/ditto/worker/memory";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { EXPERIMENT_GENERATION, EXPERIMENT_PROVIDER_OPTIONS, type ExperimentModelProfile } from "../model-profile.js";
import type { ProviderSettings } from "../config.js";
import { PythonTransport } from "./python-transport.js";

export interface ExperimentRuntime {
  readonly runtime: DittoRuntime;
  readonly provider: ModelProvider;
  readonly providerName: string;
  readonly model: string;
  close(): Promise<void>;
}

export interface ExperimentRuntimeOptions {
  readonly profile?: ExperimentModelProfile;
  readonly tools?: readonly RegisteredTool[];
  readonly memory?: MemoryResources;
  /** Application-owned provider override, also useful for deterministic checks. */
  readonly provider?: ModelProvider;
}

/** npm Graph/Loop/Workers; injected transport uses AFlow's installed SDK. */
export function createExperimentRuntime(settings: ProviderSettings, options: ExperimentRuntimeOptions = {}): ExperimentRuntime {
  const profile = options.profile ?? "math";
  const sandbox = new Sandbox(process.cwd(), { network: [new URL(settings.baseUrl).origin], tools: options.tools?.map(tool => tool.name) ?? [] });
  const transport = options.provider ? undefined : new PythonTransport(settings, { profile });
  // Per-request timeouts/retries live in OpenAI's SDK (connect 5s, read 600s).
  // A multi-call Node must not inherit a 600s total deadline including queue time.
  const nodeDeadline = 2 ** 31 - 1;
  const http = options.provider ?? createHttpProvider({
    kind: "openai-compatible", baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    maxTokensField: "max_tokens", sandbox, fetch: transport!.fetch,
    providerOptions: EXPERIMENT_PROVIDER_OPTIONS, timeoutMs: nodeDeadline,
  });
  const providerName = "deepseek";
  const provider = limitProviderConcurrency(applyModelProfile(http, profile), settings.concurrency);
  const budget = budgetOutputBoundary();
  const checked = budget.provider(withReflectionFormatRepair(provider, async event => {
    if (process.env.DITTO_PROVIDER_LOG) await appendFile(process.env.DITTO_PROVIDER_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  }));
  const runtime = createDitto({ sandbox: sandbox.policy, workers: [
    createContextWorker(profile === "automationbench" ? { policy: {
      // Highest values accepted by the public npm policy validator. Referenced
      // Context items can carry larger inline payloads without a token ceiling.
      maxItems: 1_000_000, maxInlineBytes: 1_000_000,
    } } : {}),
    budget.worker(createInferWorker({
      providers: { [providerName]: checked },
      defaultProvider: providerName, timeoutMs: nodeDeadline,
    })),
    ...(options.memory ? [createMemoryWorker(options.memory)] : []),
    ...(profile === "automationbench" || options.tools ? [createInteractionWorker({ tools: options.tools ?? [],
      ...(profile === "automationbench" ? { output: { async deliver(input) { return { deliveryId: input.deliveryId, status: "accepted" as const }; } } } : {}),
    })] : []),
  ] });
  return Object.freeze({ runtime, provider, providerName, model: settings.model,
    async close() { try { await runtime.close(); } finally { await transport?.close(); } },
  });
}

/** Enforce the same policy across SAMPLE, TRAJECTORY, optimizer and stream calls. */
export function applyModelProfile(provider: ModelProvider, _profile: ExperimentModelProfile): ModelProvider {
  function configure(input: Parameters<ModelProvider["invoke"]>[0]): Parameters<ModelProvider["invoke"]>[0] {
    const providerOptions: Record<string, unknown> = { ...input.model.providerOptions, ...EXPERIMENT_PROVIDER_OPTIONS };
    delete providerOptions.top_p;
    delete providerOptions.reasoning_effort;
    delete providerOptions.seed;
    return { ...input, generation: { ...EXPERIMENT_GENERATION }, model: { ...input.model, providerOptions } };
  }
  return {
    invoke: (input, options) => provider.invoke(configure(input), options),
    ...(provider.stream ? { stream: (input, options) => provider.stream!(configure(input), options) } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}

/** Direct handoff reserves the slot for the queued caller; newcomers cannot steal it. */
export function limitProviderConcurrency(provider: ModelProvider, maximum: number): ModelProvider {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid provider concurrency");
  let active = 0;
  const queue: Array<{ grant(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }> = [];
  function release(): void {
    const next = queue.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.grant();
    } else active--;
  }
  async function acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (active < maximum) { active++; return; }
    await new Promise<void>((grant, reject) => {
      const item = { grant, reject, signal, abort: (): void => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      } };
      queue.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }
  return {
    async invoke(input, options) {
      await acquire(options.signal);
      try { options.signal.throwIfAborted(); return await provider.invoke(input, options); }
      finally { release(); }
    },
    ...(provider.stream ? {
      async *stream(input, options) {
        await acquire(options.signal);
        try {
          options.signal.throwIfAborted();
          yield* provider.stream!(input, options);
        } finally { release(); }
      },
    } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}
