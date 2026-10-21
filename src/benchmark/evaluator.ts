import type { AgentRunResult, BenchmarkTask, CaseResult, EvaluationSummary } from "../domain.js";
import type { BenchmarkEvaluationOptions, BenchmarkRunner, PrivateScorer } from "./types.js";
import {AutomationBudget,automationBudgetScope,AUTOMATION_EXECUTION_BUDGET} from '../workflow/automation-budget.js';

export async function evaluateTasks(
  tasks: readonly BenchmarkTask[],
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  options: BenchmarkEvaluationOptions = {},
): Promise<EvaluationSummary> {
  const repeats = options.repeats ?? 1;
  const concurrency = options.concurrency ?? 1;
  const retryAttempts = options.retryAttempts ?? 5;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Evaluation repeats must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Evaluation concurrency must be a positive integer");
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1) throw new Error("Retry attempts must be a positive integer");
  if(options.workflowRetryScope!==undefined&&!['invocation','case-repeat'].includes(options.workflowRetryScope))throw Error('Invalid workflow retry scope');

  const started = Date.now();
  const results: CaseResult[] = [];
  const repeatScores: number[] = [];
  const total = tasks.length * repeats;
  let completed = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const current = await mapLimit(tasks, concurrency, async (task) => {
      const prior = options.priorCases?.find(value => value.caseId === `${task.id}#${repeat + 1}`);
      const result = prior?.valid === true && prior.error === undefined
        ? prior : await evaluateOne(task, repeat, scorer, runner, retryAttempts, prior,options.automationBudgetPersistence,options.workflowRetryScope);
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
    timeoutRuns: results.filter((result) => result.failureKind === "timeout").length,
    wrongRuns: results.filter((result) => result.error === undefined && result.score === 0).length,
    inputTokens: sum(results.map((result) => result.inputTokens)),
    outputTokens: sum(results.map((result) => result.outputTokens)),
    totalTokens: sum(results.map((result) => result.totalTokens)),
    durationMs: Date.now() - started,
    results: Object.freeze(results),
  });
}

async function evaluateOne(
  task: BenchmarkTask, repeat:number, scorer:PrivateScorer, runner:BenchmarkRunner,retryAttempts:number,prior?:CaseResult,persistence?:BenchmarkEvaluationOptions['automationBudgetPersistence'],retryScope:BenchmarkEvaluationOptions['workflowRetryScope']='invocation',
):Promise<CaseResult>{
  if(task.dataset!=='automationbench')return evaluateOneBody(task,repeat,scorer,runner,retryAttempts,prior,false,retryScope);
  const caseId=`${task.id}#${repeat+1}`,saved=persistence?.load(caseId),previous=prior?.automationBudgetProgress;
  if(saved&&previous&&(saved.startedAt!==previous.startedAt||saved.actorCalls<previous.actorCalls))throw Error('Automation budget checkpoint regressed behind saved result');
  const budget=new AutomationBudget(Date.now,saved??previous,persistence?progress=>persistence.save(caseId,progress):undefined);
  try{const result=await automationBudgetScope.run(budget,()=>evaluateOneBody(task,repeat,scorer,runner,retryAttempts,prior,saved!==undefined&&prior===undefined,retryScope));return {...result,automationBudgetProgress:budget.progress()};}
  finally{budget.close();}
}
async function evaluateOneBody(
  task: BenchmarkTask,
  repeat: number,
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  retryAttempts: number,
  prior?: CaseResult,
  interruptedBudget=false,
  retryScope:BenchmarkEvaluationOptions['workflowRetryScope']='invocation',
): Promise<CaseResult> {
  const started = Date.now();
  const attempts: NonNullable<CaseResult["attempts"]>[number][] = [...(prior?.attempts ?? [])];
  const history = prior ? { previousResults: Object.freeze([prior]) } : {};
  let run: AgentRunResult;
  try {
    if(retryScope==='case-repeat'&&interruptedBudget)throw Error('Interrupted workflow has no case-result attempt evidence; automatic fresh workflow recovery is refused');
    if(retryScope==='case-repeat'&&prior?.failureKind==='judge'&&prior.judgeRecovery===undefined)throw Error('Judge-only recovery requires a saved scoring checkpoint; automatic regeneration is refused');
    const budget=automationBudgetScope.getStore();
    if((interruptedBudget||(prior?.error&&prior.failureKind!=='judge'))&&budget&&(budget.wallExpired||budget.actorCalls>=AUTOMATION_EXECUTION_BUDGET.maxActorCalls))throw Error(`Unresolved Automation infrastructure fault with exhausted case budget: ${prior?.error??'interrupted before case result checkpoint'}`);
    run = prior?.failureKind==='judge'&&prior.judgeRecovery!==undefined
      ? {answer:prior.prediction,executedNodeIds:prior.executedNodeIds??[],executedGraphIds:prior.executedGraphIds??[],...(prior.executionBudget?{executionBudget:prior.executionBudget}:{}),...(prior.nodeOutputs?{nodeOutputs:prior.nodeOutputs}:{}),...(prior.loopTrace?{loopTrace:prior.loopTrace}:{}),inputTokens:0,outputTokens:0,totalTokens:0,usageKnown:true}
      : await retryWorkflow(() => runner(task), retryAttempts, attempts,retryScope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      caseId: `${task.id}#${repeat + 1}`,
      ...history,
      valid: false,
      usageKnown: prior?.usageKnown !== false && attempts.every(value => value.usageKnown),
      attempts: Object.freeze(attempts),
      ...aggregateUsage(undefined, attempts, prior),
      score: 0,
      expected: expectedLabel(scorer, task.id),
      prediction: "",
      normalizedExpected: "",
      normalizedPrediction: "",
      method: "evaluation-error",
      latencyMs: Date.now() - started,
      failureKind: classifyFailure(message),
      error: message,
    });
  }

  // Preserve the answer and usage even if judging fails; never turn it into a model zero.
  const providerUsage = aggregateUsage(run, attempts, prior);
  let evidence;
  try {
    evidence = await scorer.score(task.id, run.answer,prior);
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
      ...(scorer.recoveryData?{judgeRecovery:scorer.recoveryData(task.id)??prior?.judgeRecovery}:{}),
      attempts: Object.freeze(attempts), usageKnown: run.usageKnown !== false && prior?.usageKnown !== false && attempts.every(value => value.usageKnown),
      ...providerUsage,
      ...(run.checkerAudits?.length ? { checkerAudits: run.checkerAudits } : {}),
      executedNodeIds: run.executedNodeIds, executedGraphIds: run.executedGraphIds,
      ...(run.nodeOutputs ? { nodeOutputs: run.nodeOutputs } : {}),
      ...(run.loopTrace ? { loopTrace: run.loopTrace } : {}),
      ...(run.executionBudget?{executionBudget:run.executionBudget}:{}),
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
    ...(run.generationOutcomes?.length ? { generationOutcomes: run.generationOutcomes } : {}),
    ...(run.checkerAudits?.length ? { checkerAudits: run.checkerAudits } : {}),
      executedNodeIds: run.executedNodeIds, executedGraphIds: run.executedGraphIds,
      ...(run.nodeOutputs ? { nodeOutputs: run.nodeOutputs } : {}),
      ...(run.loopTrace ? { loopTrace: run.loopTrace } : {}),
      ...(run.executionBudget?{executionBudget:run.executionBudget}:{}),
    latencyMs: Date.now() - started,
  });
}

/** Retry only transient failures; preserve failed-attempt evidence and usage completeness. */
async function retryWorkflow<T>(operation: () => Promise<T>, attempts: number, failures: NonNullable<CaseResult["attempts"]>[number][],scope:BenchmarkEvaluationOptions['workflowRetryScope']='invocation'): Promise<T> {
  const previousAttempts = failures.length;
  const remaining=scope==='case-repeat'?Math.max(0,attempts-previousAttempts):attempts;
  if(remaining===0)throw Error(`Workflow attempt budget exhausted (${previousAttempts}/${attempts}); no new workflow dispatched. Previous failure: ${failures.at(-1)?.error??'unavailable'}`);
  let latest: unknown;
  for (let attempt = 1; attempt <= remaining; attempt++) {
    const caseBudget=automationBudgetScope.getStore();
    if(attempt>1&&caseBudget&&(caseBudget.wallExpired||caseBudget.actorCalls>=AUTOMATION_EXECUTION_BUDGET.maxActorCalls))throw latest;
    try {
      return await operation();
    } catch (error) {
      latest = error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(Object.freeze({ attempt: previousAttempts + attempt, error: message,
        ...errorUsage(error), failureKind: classifyFailure(message) }));
      if (attempt === remaining || !isTransient(message)||caseBudget&&(caseBudget.wallExpired||caseBudget.actorCalls>=AUTOMATION_EXECUTION_BUDGET.maxActorCalls)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "failedProviderAttempts", "providerAttempts", "unknownUsageAttempts"] as const) {
    const priorAttempts = sum((prior?.attempts ?? []).map(value => value[field] ?? 0));
    const carried = Math.max(0, (prior?.[field] ?? 0) - priorAttempts);
    result[field] = (run?.[field] ?? 0) + sum(attempts.map(value => value[field] ?? 0)) + carried;
  }
  result.providerDiagnostics = [
    ...(prior?.providerDiagnostics ?? []),
    ...attempts.slice(prior?.attempts?.length ?? 0).flatMap(value => value.providerDiagnostics ?? []),
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
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
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
