import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { ModelProvider } from "@codesoul-co/ditto/worker/infer";

export interface TimeBudgetPolicy {
  readonly requestMs: number | null;
  readonly workflowMs: number | null;
  readonly reason?: string;
}
export interface TimeBudgetOutcome {
  readonly scope: "request" | "workflow";
  readonly limitMs: number;
  readonly elapsedMs: number;
}
export class TimeBudgetExceeded extends Error {
  readonly usageKnown = false;
  readonly unknownUsageAttempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  constructor(readonly outcome: TimeBudgetOutcome, usage = { unknownUsageAttempts: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }) {
    super(`Declared ${outcome.scope} time budget exhausted (${outcome.limitMs} ms)`);
    this.name = "TimeBudgetExceeded";
    this.unknownUsageAttempts = usage.unknownUsageAttempts;
    this.inputTokens = usage.inputTokens; this.outputTokens = usage.outputTokens; this.totalTokens = usage.totalTokens;
  }
}
interface BudgetScope {
  readonly policy: TimeBudgetPolicy;
  readonly controller: AbortController;
  expired?: TimeBudgetExceeded;
  activeRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
const scopes = new AsyncLocalStorage<BudgetScope>();

export function validateTimeBudget(policy: TimeBudgetPolicy): TimeBudgetPolicy {
  for (const value of [policy.requestMs, policy.workflowMs]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1)) {
      throw Error("Time budgets must be positive integer milliseconds or explicit unlimited");
    }
  }
  if ((policy.requestMs === null || policy.workflowMs === null) && !policy.reason?.trim()) {
    throw Error("Explicit unlimited time budgets require a reason");
  }
  return Object.freeze({ ...policy });
}

/** Optional for library fixtures; formal CLI runs require an explicit policy. */
export function assertExplicitTimeBudget(policy: TimeBudgetPolicy | undefined): asserts policy is TimeBudgetPolicy {
  if (!policy) throw Error("Choose --request-timeout-ms and --workflow-timeout-ms (milliseconds or unlimited); use --time-budget-reason for unlimited");
  validateTimeBudget(policy);
}

function expire(scope: BudgetScope, kind: TimeBudgetOutcome["scope"], limitMs: number, started: number): void {
  if (scope.expired) return;
  scope.expired = new TimeBudgetExceeded({ scope: kind, limitMs, elapsedMs: performance.now() - started }, {
    unknownUsageAttempts: scope.activeRequests, inputTokens: scope.inputTokens, outputTokens: scope.outputTokens, totalTokens: scope.totalTokens,
  });
  scope.controller.abort(scope.expired);
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Starts once per task/repeat and includes its retries, queueing and tools, not grading. */
export async function withWorkflowTimeBudget<T>(policy: TimeBudgetPolicy | undefined, operation: () => Promise<T>): Promise<T> {
  if (!policy) return operation();
  validateTimeBudget(policy);
  const scope: BudgetScope = { policy, controller: new AbortController(), activeRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const started = performance.now();
  const timer = policy.workflowMs === null ? undefined : setTimeout(() => expire(scope, "workflow", policy.workflowMs!, started), policy.workflowMs);
  try {
    return await scopes.run(scope, async () => {
      try { return await abortable(operation, scope.controller.signal); }
      catch (error) { throw scope.expired ?? error; }
    });
  } finally { if (timer) clearTimeout(timer); }
}

export function currentTimeBudgetSignal(): AbortSignal | undefined { return scopes.getStore()?.controller.signal; }
export function throwIfTimeBudgetExceeded(): void { scopes.getStore()?.controller.signal.throwIfAborted(); }

/** Put inside the provider semaphore so application queue time is excluded from requestMs. */
export function withRequestTimeBudget(provider: ModelProvider, fallback?: TimeBudgetPolicy): ModelProvider {
  async function request<T>(signal: AbortSignal, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
    const existing = scopes.getStore();
    if (!existing && fallback) return withWorkflowTimeBudget({ ...fallback, workflowMs: null, reason: fallback.reason ?? "Optimizer request only; no benchmark workflow" }, () => request(signal, operation));
    const scope = scopes.getStore();
    if (!scope) return operation(signal);
    const combined = AbortSignal.any([signal, scope.controller.signal]);
    const started = performance.now();
    const limit = scope.policy.requestMs;
    const timer = limit === null ? undefined : setTimeout(() => expire(scope, "request", limit, started), limit);
    scope.activeRequests++;
    try {
      const result = await abortable(() => operation(combined), combined);
      const usage = (result as { usage?: {inputTokens?:number;outputTokens?:number;totalTokens?:number} })?.usage;
      if (usage) {
        scope.inputTokens += usage.inputTokens ?? 0; scope.outputTokens += usage.outputTokens ?? 0;
        scope.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
      return result;
    }
    catch (error) { throw scope.expired ?? error; }
    finally { scope.activeRequests--; if (timer) clearTimeout(timer); }
  }
  return {
    invoke: (input, options) => request(options.signal, signal => provider.invoke(input, { ...options, signal })),
    ...(provider.stream ? { async *stream(input, options) {
      // Preserve the deadline across all chunks; ongoing output never resets it.
      const scope = scopes.getStore();
      const limit = scope?.policy.requestMs ?? fallback?.requestMs;
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal, ...(scope ? [scope.controller.signal] : [])]);
      const started = performance.now();
      const timer = limit == null ? undefined : setTimeout(() => {
        if (scope) expire(scope, "request", limit, started);
        else controller.abort(new TimeBudgetExceeded({ scope: "request", limitMs: limit, elapsedMs: performance.now() - started }));
      }, limit);
      const iterator = provider.stream!(input, { ...options, signal })[Symbol.asyncIterator]();
      if (scope) scope.activeRequests++;
      try {
        for (;;) {
          const next = await abortable(() => iterator.next(), signal);
          if (next.done) break;
          yield next.value;
        }
      } catch (error) { throw scope?.expired ?? error; }
      finally {
        if (scope) scope.activeRequests--;
        if (timer) clearTimeout(timer);
        controller.abort(new Error("Provider stream closed"));
        // A canceled transport must not hold the evaluation waiting for generator cleanup.
        void iterator.return?.().catch(() => undefined);
      }
    } } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}
