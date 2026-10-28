import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { ModelProvider } from "@codesoul-co/ditto/worker/infer";
import type { ProviderCallDiagnostics } from "../domain.js";
import { captureProviderDiagnostics, currentProviderDiagnostics, summarizeProviderDiagnostics, withProviderDiagnostics } from "../ditto/provider-diagnostics.js";

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
  readonly workflowUsage = true;
  readonly providerAttempts: number;
  readonly failedProviderAttempts: number;
  readonly providerDiagnostics: readonly ProviderCallDiagnostics[];
  readonly unknownUsageAttempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  constructor(readonly outcome: TimeBudgetOutcome, usage: Partial<ProviderUsage> = {}) {
    super(`Declared ${outcome.scope} time budget exhausted (${outcome.limitMs} ms)`);
    this.name = "TimeBudgetExceeded";
    this.providerAttempts = usage.providerAttempts ?? 1;
    this.failedProviderAttempts = usage.failedProviderAttempts ?? 0;
    this.providerDiagnostics = usage.providerDiagnostics ?? [];
    this.unknownUsageAttempts = usage.unknownUsageAttempts ?? 1;
    this.inputTokens = usage.inputTokens ?? 0; this.outputTokens = usage.outputTokens ?? 0; this.totalTokens = usage.totalTokens ?? 0;
  }
}
interface BudgetScope {
  readonly policy: TimeBudgetPolicy;
  readonly controller: AbortController;
  expired?: TimeBudgetExceeded;
  infrastructureFailure?: Error;
  activeRequests: number;
  providerAttempts: number;
  failedProviderAttempts: number;
  unknownUsageAttempts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  readonly diagnostics: ProviderCallDiagnostics[];
  readonly cleanups: Set<Promise<unknown>>;
}
const scopes = new AsyncLocalStorage<BudgetScope>();

export interface ProviderUsage {
  readonly workflowUsage: true;
  readonly usageKnown: boolean;
  readonly providerAttempts: number;
  readonly failedProviderAttempts: number;
  readonly unknownUsageAttempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly providerDiagnostics: readonly ProviderCallDiagnostics[];
}
function snapshot(scope: BudgetScope): ProviderUsage {
  return Object.freeze({ workflowUsage: true, usageKnown: scope.activeRequests === 0 && scope.unknownUsageAttempts === 0,
    providerAttempts: scope.providerAttempts, failedProviderAttempts: scope.failedProviderAttempts,
    unknownUsageAttempts: scope.unknownUsageAttempts + scope.activeRequests,
    inputTokens: scope.inputTokens, outputTokens: scope.outputTokens, totalTokens: scope.totalTokens,
    providerDiagnostics: Object.freeze([...scope.diagnostics]) });
}
/** Whole-task ledger includes completed independent Graph siblings and retries. */
export function currentProviderUsage(): ProviderUsage | undefined {
  const scope = scopes.getStore(); return scope ? snapshot(scope) : undefined;
}
export function currentTimeBudgetPolicy(): TimeBudgetPolicy | undefined { return scopes.getStore()?.policy; }
export function recordTimeBudgetInfrastructureFailure(error: unknown): void {
  const scope = scopes.getStore();
  if (scope && !(error instanceof TimeBudgetExceeded)) scope.infrastructureFailure ??= error instanceof Error ? error : new Error(String(error));
}
/** Child-process callbacks must retain the request's scope, not their event-loop context. */
export function timeBudgetFailureRecorder(): (error: Error) => void {
  const scope = scopes.getStore();
  return error => { if (scope && !scope.expired) scope.infrastructureFailure ??= error; };
}
/** Owned Worker/process shutdown must finish before the next evaluation slot. */
export function timeBudgetCleanupRegistrar(): (cleanup: Promise<unknown>) => void {
  const scope = scopes.getStore();
  return cleanup => {
    if (!scope) return;
    scope.cleanups.add(cleanup);
    const remove = (): void => { scope.cleanups.delete(cleanup); };
    void cleanup.then(remove, remove);
  };
}
function expiredError(scope: BudgetScope): Error | undefined {
  if (!scope.infrastructureFailure) return scope.expired ? new TimeBudgetExceeded(scope.expired.outcome, snapshot(scope)) : undefined;
  return Object.assign(new Error(scope.infrastructureFailure.message, { cause: scope.infrastructureFailure }), snapshot(scope),
    { workflowUsage: true, ...(scope.expired ? { timeBudgetOutcome: scope.expired.outcome } : {}) });
}

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
    ...snapshot(scope),
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
  const scope: BudgetScope = { policy: validateTimeBudget(policy), controller: new AbortController(), activeRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    providerAttempts: 0, failedProviderAttempts: 0, unknownUsageAttempts: 0, diagnostics: [], cleanups: new Set() };
  const started = performance.now();
  const timer = policy.workflowMs === null ? undefined : setTimeout(() => expire(scope, "workflow", policy.workflowMs!, started), policy.workflowMs);
  try {
    return await scopes.run(scope, async () => {
      const pending = Promise.resolve().then(operation);
      try { return await abortable(() => pending, scope.controller.signal); }
      catch (error) {
        if (!scope.expired) throw error;
        await Promise.allSettled([...scope.cleanups]);
        // Give cooperative SDK/Worker aborts and task-local finally blocks time
        // to drain before another case consumes the same concurrency slot.
        let cleanupTimer: NodeJS.Timeout | undefined;
        try { await Promise.race([pending.catch(() => undefined), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1_000); })]); }
        finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
        throw expiredError(scope);
      }
    });
  } finally { if (timer) clearTimeout(timer); }
}

export function currentTimeBudgetSignal(): AbortSignal | undefined { return scopes.getStore()?.controller.signal; }
export function throwIfTimeBudgetExceeded(): void { scopes.getStore()?.controller.signal.throwIfAborted(); }

function settleUsage(scope: BudgetScope, records: readonly ProviderCallDiagnostics[], output: { usage?: {inputTokens?:number;outputTokens?:number;totalTokens?:number} } | undefined, failed: boolean): void {
  const diagnostics = records.length ? summarizeProviderDiagnostics(records) : undefined;
  scope.providerAttempts += (diagnostics?.providerAttempts ?? 1) - 1;
  scope.failedProviderAttempts += diagnostics?.failedProviderAttempts ?? (failed ? 1 : 0);
  scope.unknownUsageAttempts += diagnostics?.unknownUsageAttempts ?? (output?.usage ? 0 : 1);
  scope.inputTokens += diagnostics?.inputTokens ?? output?.usage?.inputTokens ?? 0;
  scope.outputTokens += diagnostics?.outputTokens ?? output?.usage?.outputTokens ?? 0;
  scope.totalTokens += diagnostics?.totalTokens ?? output?.usage?.totalTokens ?? ((output?.usage?.inputTokens ?? 0) + (output?.usage?.outputTokens ?? 0));
  scope.diagnostics.push(...records);
}

/** Put inside the provider semaphore so application queue time is excluded from requestMs. */
export function withRequestTimeBudget(provider: ModelProvider, fallback?: TimeBudgetPolicy): ModelProvider {
  async function request<T>(signal: AbortSignal, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
    const existing = scopes.getStore();
    if (!existing && fallback) return withWorkflowTimeBudget({ ...fallback, workflowMs: null, reason: fallback.reason ?? "Optimizer request only; no benchmark workflow" }, () => request(signal, operation));
    const scope = scopes.getStore();
    if (!scope) return operation(signal);
    const combined = AbortSignal.any([signal, scope.controller.signal]);
    combined.throwIfAborted();
    const started = performance.now();
    const limit = scope.policy.requestMs;
    const timer = limit === null ? undefined : setTimeout(() => expire(scope, "request", limit, started), limit);
    scope.activeRequests++; scope.providerAttempts++;
    const parentRecords = currentProviderDiagnostics();
    let records: ProviderCallDiagnostics[] = [];
    let output: { usage?: {inputTokens?:number;outputTokens?:number;totalTokens?:number} } | undefined;
    let failed = true;
    try {
      const result = await captureProviderDiagnostics(async observed => {
        records = observed; return abortable(() => operation(combined), combined);
      });
      output = result as typeof output; failed = false;
      return result;
    }
    catch (error) {
      if (!scope.expired) recordTimeBudgetInfrastructureFailure(error);
      throw scope.expired ?? error;
    }
    finally {
      scope.activeRequests--; settleUsage(scope, records, output, failed);
      parentRecords?.push(...records);
      if (timer) clearTimeout(timer);
    }
  }
  return {
    invoke: (input, options) => request(options.signal, signal => provider.invoke(input, { ...options, signal })),
    ...(provider.stream ? { async *stream(input, options) {
      // Preserve the deadline across all chunks; ongoing output never resets it.
      const scope = scopes.getStore();
      const limit = scope ? scope.policy.requestMs : fallback?.requestMs;
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal, ...(scope ? [scope.controller.signal] : [])]);
      const started = performance.now();
      const timer = limit == null ? undefined : setTimeout(() => {
        if (scope) expire(scope, "request", limit, started);
        else controller.abort(new TimeBudgetExceeded({ scope: "request", limitMs: limit, elapsedMs: performance.now() - started }));
      }, limit);
      const iterator = provider.stream!(input, { ...options, signal })[Symbol.asyncIterator]();
      const records: ProviderCallDiagnostics[] = [];
      const parentRecords = currentProviderDiagnostics();
      if (scope) { scope.activeRequests++; scope.providerAttempts++; }
      let output: { usage?: {inputTokens?:number;outputTokens?:number;totalTokens?:number} } | undefined;
      let failed = true;
      try {
        for (;;) {
          const next = await withProviderDiagnostics(records, () => abortable(() => iterator.next(), signal));
          if (next.done) break;
          if (next.value.type === "result") output = next.value.output;
          yield next.value;
        }
        failed = false;
      } catch (error) {
        if (scope && !scope.expired) recordTimeBudgetInfrastructureFailure(error);
        throw scope?.expired ?? error;
      }
      finally {
        if (scope) { scope.activeRequests--; settleUsage(scope, records, output, failed); }
        parentRecords?.push(...records);
        if (timer) clearTimeout(timer);
        controller.abort(new Error("Provider stream closed"));
        // A canceled transport must not hold the evaluation waiting for generator cleanup.
        void iterator.return?.().catch(() => undefined);
      }
    } } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}
