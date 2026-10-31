import { withReflectionFormatRepair, type ReflectionRepairEvent } from "./reflection-format.js";
import { budgetOutputBoundary } from "./budget-output.js";
import { appendFile } from "node:fs/promises";
import { createDitto, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createHttpProvider, createInferWorker, type ModelProvider, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import type { ProviderCallDiagnostics } from "../domain.js";
import { captureProviderDiagnostics, currentProviderDiagnostics } from "./provider-diagnostics.js";
import { createMemoryWorker, type MemoryResources } from "@codesoul-co/ditto/worker/memory";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { EXPERIMENT_GENERATION, EXPERIMENT_PROVIDER_OPTIONS, type ExperimentModelProfile } from "../model-profile.js";
import type { ProviderSettings } from "../config.js";
import { PythonTransport } from "./python-transport.js";
import { withRequestTimeBudget, type TimeBudgetPolicy } from "../execution/time-budget.js";
import { observeCapabilityWorkers } from "../workflow/capability-observer.js";
import {automationBudgetScope} from '../execution/automation-budget.js';

export interface ExperimentRuntime {
  readonly reflectionEvent?: (event: ReflectionRepairEvent) => void | Promise<void>;
  readonly runtime: DittoRuntime;
  readonly provider: ModelProvider;
  readonly providerName: string;
  readonly model: string;
  close(): Promise<void>;
}

export interface ExperimentRuntimeOptions {
  readonly workers?: readonly WorkerDefinition[];
  readonly connectTimeoutMs?: number;
  readonly beforeProviderCall?: (input: SampleInput) => void | Promise<void>;
  readonly afterProviderCall?: (event: ProviderInvocationEvent) => void | Promise<void>;
  readonly reflectionEvent?: (event: ReflectionRepairEvent) => void | Promise<void>;
  readonly timeBudget?: TimeBudgetPolicy;
  /** Reuse the one application-owned provider gate for task-local resources. */
  readonly managedProvider?: boolean;
  readonly profile?: ExperimentModelProfile;
  readonly tools?: readonly RegisteredTool[];
  readonly memory?: MemoryResources;
  /** Application-owned provider override, also useful for deterministic checks. */
  readonly provider?: ModelProvider;
}

export interface ProviderInvocationEvent {
  readonly input: SampleInput;
  readonly output?: SampleOutput;
  readonly error?: unknown;
  readonly diagnostics: readonly ProviderCallDiagnostics[];
}

/** npm Graph/Loop/Workers; injected transport uses AFlow's installed SDK. */
export function createExperimentRuntime(settings: ProviderSettings, options: ExperimentRuntimeOptions = {}): ExperimentRuntime {
  const profile = options.profile ?? "math";
  if (profile === "automationbench" && !options.memory) throw new Error("AutomationBench requires application-owned Memory resources");
  const sandbox = new Sandbox(process.cwd(), { network: [new URL(settings.baseUrl).origin], tools: options.tools?.map(tool => tool.name) ?? [] });
  const transport = options.provider ? undefined : new PythonTransport(settings, { profile,
    ...(options.timeBudget ? { requestTimeoutMs: options.timeBudget.requestMs } : {}), connectTimeoutMs: options.connectTimeoutMs ?? 10_000 });
  // Declared request budgets also reach the SDK; connection establishment has
  // its own explicit 10s infrastructure limit, including unlimited requests.
  // A multi-call Node must not inherit a 600s total deadline including queue time.
  const nodeDeadline = 2 ** 31 - 1;
  const http = options.provider ?? createHttpProvider({
    kind: "openai-compatible", baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    maxTokensField: "max_tokens", sandbox, fetch: transport!.fetch,
    providerOptions: EXPERIMENT_PROVIDER_OPTIONS, timeoutMs: nodeDeadline,
  });
  const providerName = "deepseek";
  const provider = options.managedProvider && options.provider ? options.provider
    : limitProviderConcurrency(withProviderLifecycle(withRequestTimeBudget(applyModelProfile(http, profile), options.timeBudget), options), settings.concurrency);
  const budget = budgetOutputBoundary();
  const checked = budget.provider(withReflectionFormatRepair(provider, async event => {
    await options.reflectionEvent?.(event);
    if (process.env.DITTO_PROVIDER_LOG) await appendFile(process.env.DITTO_PROVIDER_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  }));
  const runtime = createDitto({ sandbox: sandbox.policy, workers: observeCapabilityWorkers([
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
    ...(options.workers ?? []),
    ...(profile === "automationbench" || options.tools ? [createInteractionWorker({ tools: options.tools ?? [],
      ...(profile === "automationbench" ? { output: { async deliver(input) { return { deliveryId: input.deliveryId, status: "accepted" as const }; } } } : {}),
    })] : []),
  ]) });
  return Object.freeze({ runtime, provider, providerName, model: settings.model,...(options.reflectionEvent?{reflectionEvent:options.reflectionEvent}:{}),
    async close() { try { await runtime.close(); } finally { await transport?.close(); } },
  });
}

/** Admission occurs after the concurrency queue; every nested native/repair call is charged. */
export function withProviderLifecycle(provider: ModelProvider, hooks: Pick<ExperimentRuntimeOptions, "beforeProviderCall" | "afterProviderCall">): ModelProvider {
  return {
    async invoke(input, options) {
      options.signal.throwIfAborted();
      automationBudgetScope.getStore()?.claimActor();
      await hooks.beforeProviderCall?.(input);
      const parent = currentProviderDiagnostics();
      return captureProviderDiagnostics(async diagnostics => {
        let output: SampleOutput | undefined;
        let error: unknown;
        try { output = await provider.invoke(input, options); return output; }
        catch (failure) { error = failure; throw failure; }
        finally {
          parent?.push(...diagnostics);
          await hooks.afterProviderCall?.({ input, diagnostics, ...(output ? { output } : {}), ...(error !== undefined ? { error } : {}) });
        }
      });
    },
    ...(provider.stream ? {
      async *stream(input: SampleInput, options: { signal: AbortSignal }) {
        options.signal.throwIfAborted();
        automationBudgetScope.getStore()?.claimActor();
        await hooks.beforeProviderCall?.(input);
        const parent = currentProviderDiagnostics();
        const diagnostics: ProviderCallDiagnostics[] = [];
        let output: SampleOutput | undefined;
        let error: unknown;
        const iterator = provider.stream!(input, options)[Symbol.asyncIterator]();
        const { withProviderDiagnostics } = await import('./provider-diagnostics.js');
        try {
          while (true) {
            const item = await withProviderDiagnostics(diagnostics, () => iterator.next());
            if (item.done) break;
            if (item.value.type === 'result') output = item.value.output;
            yield item.value;
          }
        } catch (failure) { error = failure; throw failure; }
        finally {
          try { await withProviderDiagnostics(diagnostics, async () => { await iterator.return?.(); }); }
          finally {
            parent?.push(...diagnostics);
            await hooks.afterProviderCall?.({ input, diagnostics, ...(output ? { output } : {}), ...(error !== undefined ? { error } : {}) });
          }
        }
      },
    } : {}),
  };
}

/** Enforce the same policy across SAMPLE, TRAJECTORY, optimizer and stream calls. */
export function applyModelProfile(provider: ModelProvider, profile: ExperimentModelProfile): ModelProvider {
  const check = (output: SampleOutput): SampleOutput => {
    if(output.finishReason==='error')throw Object.assign(new Error('Provider generation failed (finish_reason=error)'),{code:'PROVIDER_GENERATION_ERROR',infrastructureFailure:true});
    return output;
  };
  function configure(input: Parameters<ModelProvider["invoke"]>[0]): Parameters<ModelProvider["invoke"]>[0] {
    const providerOptions: Record<string, unknown> = { ...input.model.providerOptions, ...EXPERIMENT_PROVIDER_OPTIONS };
    if (profile === "optimizer" && input.model.providerOptions?.response_format !== undefined)
      providerOptions.response_format = input.model.providerOptions.response_format;
    delete providerOptions.top_p;
    delete providerOptions.reasoning_effort;
    delete providerOptions.seed;
    return { ...input, generation: { ...EXPERIMENT_GENERATION }, model: { ...input.model, providerOptions } };
  }
  return {
    invoke: async (input, options) => check(await provider.invoke(configure(input), options)),
    ...(provider.stream ? { async *stream(input, options) {for await(const event of provider.stream!(configure(input),options)){if(event.type==='result')check(event.output);yield event;}} } satisfies Pick<ModelProvider, "stream"> : {}),
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
