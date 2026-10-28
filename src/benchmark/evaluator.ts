import type { AgentRunResult, BenchmarkTask, CaseResult, EvaluationSummary } from "../domain.js";
import type { BenchmarkEvaluationOptions, BenchmarkRunner, PrivateScorer } from "./types.js";
import { setTimeout as delay } from "node:timers/promises";
import { TimeBudgetExceeded, currentTimeBudgetSignal, recordTimeBudgetInfrastructureFailure, throwIfTimeBudgetExceeded, validateTimeBudget, withWorkflowTimeBudget, type TimeBudgetPolicy } from "../execution/time-budget.js";

export async function evaluateTasks(
  tasks: readonly BenchmarkTask[],
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  options: BenchmarkEvaluationOptions = {},
): Promise<EvaluationSummary> {
  const repeats = options.repeats ?? 1;
  const concurrency = options.concurrency ?? 1;
  const retryAttempts = options.retryAttempts ?? 5;
  if (options.timeBudget) validateTimeBudget(options.timeBudget);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Evaluation repeats must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Evaluation concurrency must be a positive integer");
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1) throw new Error("Retry attempts must be a positive integer");

  const started = Date.now();
  const results: CaseResult[] = [];
  const repeatScores: number[] = [];
  const total = tasks.length * repeats;
  let completed = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const current = await mapLimit(tasks, concurrency, async (task) => {
      const prior = options.priorCases?.find(value => value.caseId === `${task.id}#${repeat + 1}`);
      const result = prior?.valid === true && prior.error === undefined
        ? prior : await evaluateOne(task, repeat, scorer, runner, retryAttempts, prior, options.timeBudget);
      completed++;
      await options.onCase?.({ completed, total, result });
      return result;
    });
    results.push(...current);
    repeatScores.push(current.every((result) => result.valid) ? mean(current.map((result) => result.score)) : 0);
  }
  const valid = total > 0 && results.every((result) => result.valid);
  return Object.freeze({
    valid,
    validRuns: results.filter((result) => result.valid).length,
    candidateFailureRuns: results.filter(result=>result.candidateFailure!==undefined).length,
    unknownUsageRuns: results.filter((result) => !result.usageKnown).length,
    tokenUsageStatus: results.every((result) => result.usageKnown) ? "complete" : "known-lower-bound",
    providerAttemptCount: sum(results.map((result) => result.providerAttempts ?? 0)),
    unknownUsageAttemptCount: sum(results.map((result) => result.unknownUsageAttempts ?? 0)),
    failedAttemptCount: sum(results.map((result) => (result.attempts?.length ?? 0) + (result.failedProviderAttempts ?? 0))),
    repeatScores: Object.freeze(repeatScores),
    score: valid ? mean(repeatScores) : 0,
    standardDeviation: valid ? standardDeviation(repeatScores) : 0,
    repeats,
    examples: tasks.length,
    successfulRuns: results.filter((result) => result.error === undefined).length,
    failedRuns: results.filter((result) => result.error !== undefined).length,
    timeoutRuns: results.filter((result) => result.failureKind === "timeout" || result.timeBudgetOutcome).length,
    wrongRuns: results.filter((result) => result.error === undefined && result.score === 0).length,
    inputTokens: sum(results.map((result) => result.inputTokens)),
    outputTokens: sum(results.map((result) => result.outputTokens)),
    totalTokens: sum(results.map((result) => result.totalTokens)),
    durationMs: Date.now() - started,
    results: Object.freeze(results),
  });
}

async function evaluateOne(
  task: BenchmarkTask,
  repeat: number,
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  retryAttempts: number,
  prior?: CaseResult,
  timeBudget?: TimeBudgetPolicy,
): Promise<CaseResult> {
  const started = Date.now();
  const attempts: NonNullable<CaseResult["attempts"]>[number][] = [...(prior?.attempts ?? [])];
  const history = prior ? { previousResults: Object.freeze([prior]) } : {};
  let run: AgentRunResult;
  try {
    run = await withWorkflowTimeBudget(timeBudget, () => retryWorkflow(() => runner(task), retryAttempts, attempts));
  } catch (error) {
    if (error instanceof TimeBudgetExceeded) {
      return Object.freeze({
        caseId: `${task.id}#${repeat + 1}`, ...history, valid: true, usageKnown: false,
        attempts: Object.freeze(attempts), ...aggregateUsage(error, attempts, prior),
        score: 0, expected: expectedLabel(scorer, task.id), prediction: "",
        normalizedExpected: "", normalizedPrediction: "", method: "time-budget-exhausted",
        timeBudgetOutcome: error.outcome, latencyMs: Date.now() - started,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      caseId: `${task.id}#${repeat + 1}`,
      ...history,
      valid: false,
      usageKnown: prior?.usageKnown !== false && attempts.every(value => value.usageKnown)
        && (!(error as {workflowUsage?:boolean})?.workflowUsage || (error as {usageKnown?:boolean}).usageKnown === true),
      attempts: Object.freeze(attempts),
      ...aggregateUsage((error as { workflowUsage?: boolean })?.workflowUsage ? error as Partial<Usage> : undefined, attempts, prior),
      score: 0,
      expected: expectedLabel(scorer, task.id),
      prediction: "",
      normalizedExpected: "",
      normalizedPrediction: "",
      method: "evaluation-error",
      latencyMs: Date.now() - started,
      failureKind: classifyFailure(message),
      error: message,
      ...((error as { timeBudgetOutcome?: unknown })?.timeBudgetOutcome ? { timeBudgetOutcome: (error as TimeBudgetExceeded & {timeBudgetOutcome: TimeBudgetExceeded["outcome"]}).timeBudgetOutcome } : {}),
    });
  }

  // Preserve the answer and usage even if judging fails; never turn it into a model zero.
  const providerUsage = aggregateUsage(run, attempts, prior);
  let evidence;
  try {
    evidence = await scorer.score(task.id, run.answer);
    if (!Number.isFinite(evidence.score) || evidence.score < 0 || evidence.score > 1) {
      throw new Error(`Scorer returned invalid score: ${evidence.score}`);
    }
  } catch (error) {
    return Object.freeze({
      caseId: `${task.id}#${repeat + 1}`, valid: false,
      ...history,
      score: 0, expected: expectedLabel(scorer, task.id), prediction: run.answer,
      normalizedExpected: "", normalizedPrediction: "", method: "judge-error",
      failureKind: "judge", error: error instanceof Error ? error.message : String(error),
      attempts: Object.freeze(attempts), usageKnown: run.usageKnown !== false && prior?.usageKnown !== false && attempts.every(value => value.usageKnown),
      ...providerUsage,
      ...(run.checkerAudits?.length ? { checkerAudits: run.checkerAudits } : {}),
      latencyMs: Date.now() - started,
    });
  }
  return Object.freeze({
    caseId: `${task.id}#${repeat + 1}`,
    ...history,
    valid: true,
    usageKnown: run.usageKnown !== false && prior?.usageKnown !== false && attempts.every(value => value.usageKnown),
    ...providerUsage,
    attempts: Object.freeze(attempts),
    ...evidence,
    ...(run.candidateFailure?{candidateFailure:run.candidateFailure}:{}),
    ...(run.generationOutcomes?.length ? { generationOutcomes: run.generationOutcomes } : {}),
    ...(run.checkerAudits?.length ? { checkerAudits: run.checkerAudits } : {}),
    latencyMs: Date.now() - started,
  });
}

/** Retry only transient failures; preserve failed-attempt evidence and usage completeness. */
async function retryWorkflow<T>(operation: () => Promise<T>, attempts: number, failures: NonNullable<CaseResult["attempts"]>[number][]): Promise<T> {
  const previousAttempts = failures.length;
  let latest: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfTimeBudgetExceeded();
    try {
      return await operation();
    } catch (error) {
      throwIfTimeBudgetExceeded();
      recordTimeBudgetInfrastructureFailure(error);
      latest = error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(Object.freeze({ attempt: previousAttempts + attempt, error: message,
        ...errorUsage(error), failureKind: classifyFailure(message) }));
      if (attempt === attempts || !isTransient(message)) throw error;
      await delay(1_000, undefined, { signal: currentTimeBudgetSignal() });
    }
  }
  throw latest;
}

type Usage = Pick<AgentRunResult, "inputTokens" | "outputTokens" | "totalTokens" | "failedProviderAttempts" | "providerAttempts" | "unknownUsageAttempts" | "providerDiagnostics">;

function errorUsage(error: unknown): Partial<Usage> & { readonly usageKnown: boolean } {
  if (!error || typeof error !== "object") return { usageKnown: false };
  const value = error as Partial<Usage> & { readonly usageKnown?: boolean };
  const usage: Record<string, unknown> & { usageKnown: boolean } = { usageKnown: value.usageKnown === true };
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "failedProviderAttempts", "providerAttempts", "unknownUsageAttempts"] as const) {
    if (typeof value[field] === "number" && Number.isFinite(value[field]) && value[field]! >= 0) usage[field] = value[field];
  }
  if (Array.isArray(value.providerDiagnostics)) usage.providerDiagnostics = value.providerDiagnostics;
  return usage;
}

function aggregateUsage(run: Partial<Usage> | undefined, attempts: NonNullable<CaseResult["attempts"]>, prior?: CaseResult): Usage {
  const result: Record<string, unknown> = {};
  const wholeWorkflow = (run as { workflowUsage?: boolean } | undefined)?.workflowUsage === true;
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "failedProviderAttempts", "providerAttempts", "unknownUsageAttempts"] as const) {
    const priorAttempts = sum((prior?.attempts ?? []).map(value => value[field] ?? 0));
    const carried = Math.max(0, (prior?.[field] ?? 0) - priorAttempts);
    result[field] = (run?.[field] ?? 0) + (wholeWorkflow ? prior?.[field] ?? 0 : sum(attempts.map(value => value[field] ?? 0)) + carried);
  }
  result.providerDiagnostics = [
    ...(prior?.providerDiagnostics ?? []),
    ...(wholeWorkflow ? [] : attempts.slice(prior?.attempts?.length ?? 0).flatMap(value => value.providerDiagnostics ?? [])),
    ...(run?.providerDiagnostics ?? []),
  ];
  return result as unknown as Usage;
}

function classifyFailure(message: string): NonNullable<CaseResult["failureKind"]> {
  if (/(?:\[TIMEOUT\]|deadline exceeded|timed out|ETIMEDOUT|HTTP 504)/i.test(message)) return "timeout";
  if (/(?:\[PROVIDER_OUTPUT_TRUNCATED\]|HTTP \d{3}|ECONNRESET|fetch failed|unauthorized|insufficient.*(?:balance|quota)|authentication)/i.test(message)) return "provider";
  if (/(?:private tests|Docker judge|Python evaluation)/i.test(message)) return "judge";
  return "execution";
}

function isTransient(message: string): boolean {
  if (/(?:HTTP (?:400|401|402|403|404|405|422)|authentication|unauthorized|insufficient.*(?:balance|quota)|invalid.*(?:parameter|api.?key))/i.test(message)) return false;
  return /(?:\[TIMEOUT\]|deadline exceeded|timed out|ETIMEDOUT|HTTP (?:408|409|425|429|5\d\d)|ECONNRESET|fetch failed)/i.test(message);
}

function expectedLabel(scorer: PrivateScorer, taskId: string): string {
  try { return scorer.expectedLabel(taskId); } catch { return ""; }
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed) {
      const index = cursor++;
      if (index >= values.length) return;
      try { results[index] = await operation(values[index]!); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failed) throw failure;
  return results;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function standardDeviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/** Legacy records without validity are accepted only when complete and error-free. */
export function assertValidEvaluation(value: EvaluationSummary): void {
  if (value.valid === false || value.failedRuns > 0 || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
    || value.examples < 1 || value.repeats < 1 || value.successfulRuns !== value.examples * value.repeats
    || value.results.some(result => result.valid === false || result.error !== undefined)) {
    throw new Error("Invalid evaluation cannot enter search ranking or feedback");
  }
}
