import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelProvider, SampleInput } from "@codesoul-co/ditto/worker/infer";
import { evaluateTasks } from "../benchmark/evaluator.js";
import type { BenchmarkTask } from "../domain.js";
import { parseArguments } from "../config.js";
import { TimeBudgetExceeded, assertExplicitTimeBudget, withRequestTimeBudget, withWorkflowTimeBudget } from "../execution/time-budget.js";
import { createExperimentRuntime, limitProviderConcurrency } from "../ditto/runtime.js";
import { createWorkflowRunner } from "../workflow/runner.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";
import { GENERATION } from "../protocol.js";

const input: SampleInput = { model: { model: "fixture" }, messages: [{ role: "user", content: "fixture" }], generation: GENERATION };
const task: BenchmarkTask = { id: "fixture", dataset: "gsm8k", prompt: "1+1", outputInstruction: "number", metadata: {} };
const answer = { answer: "2", executedNodeIds: [], executedGraphIds: [], inputTokens: 1, outputTokens: 1, totalTokens: 2, usageKnown: true };
const scorer = { expectedLabel() { return "2"; }, async score() { return { score: 1, expected: "2", prediction: "2", normalizedExpected: "2", normalizedPrediction: "2", method: "fixture" }; } };
const unlimited = { requestMs: null, workflowMs: null, reason: "Explicit fixture comparison" };
const options = () => ({ signal: new AbortController().signal });

test("formal runs require explicit budgets; unlimited requires a reason; CLI accepts per-run values", () => {
  assert.throws(() => assertExplicitTimeBudget(undefined), /Choose/);
  assert.throws(() => parseArguments(["search", "--request-timeout-ms", "unlimited", "--workflow-timeout-ms", "unlimited"]), /reason/);
  assert.throws(() => parseArguments(["search", "--request-timeout-ms", "10"]), /workflow-timeout/);
  assert.deepEqual(parseArguments(["search", "--request-timeout-ms", "600000", "--workflow-timeout-ms", "1200000"]).timeBudget, { requestMs: 600000, workflowMs: 1200000 });
  assert.deepEqual(parseArguments(["search", "--request-timeout-ms", "unlimited", "--workflow-timeout-ms", "unlimited", "--time-budget-reason", unlimited.reason]).timeBudget, unlimited);
  assert.throws(() => parseArguments(["test", "--run-dir", "fixture", "--request-timeout-ms", "NaN", "--workflow-timeout-ms", "20"]));
});

test("request deadline aborts a continuously streaming provider; output does not reset its timer", async () => {
  let aborted = false;
  const raw: ModelProvider = { async invoke() { throw Error("not used"); }, async *stream(_input, { signal }) {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    while (!signal.aborted) { await delay(3, undefined, { signal }); yield { type: "text_delta", delta: "still generating" }; }
  } };
  const provider = withRequestTimeBudget(raw);
  let chunks = 0;
  await assert.rejects(withWorkflowTimeBudget({ requestMs: 60, workflowMs: 1000 }, async () => {
    for await (const _chunk of provider.stream!(input, options())) chunks++;
  }), error => error instanceof TimeBudgetExceeded && error.outcome.scope === "request");
  assert.ok(chunks > 0); assert.equal(aborted, true);
});

test("request timeout is a valid zero, preserves denominator, cancels provider and is never retried", async () => {
  let calls = 0, aborted = false;
  const provider = withRequestTimeBudget({ async invoke(_input, { signal }) {
    calls++; signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await delay(1000, undefined, { signal });
    return { message: { role: "assistant", content: "2" }, finishReason: "stop" };
  } });
  const result = await evaluateTasks([task], scorer, async () => { await provider.invoke(input, options()); return answer; }, { retryAttempts: 5, timeBudget: { requestMs: 40, workflowMs: 500 } });
  assert.equal(result.valid, true); assert.equal(result.validRuns, 1); assert.equal(result.score, 0);
  assert.equal(result.timeoutRuns, 1); assert.equal(result.failedRuns, 0); assert.equal(result.results[0]?.method, "time-budget-exhausted");
  assert.equal(result.results[0]?.timeBudgetOutcome?.scope, "request"); assert.equal(result.results[0]?.usageKnown, false);
  assert.equal(calls, 1); assert.equal(aborted, true);
  const resumed = await evaluateTasks([task], scorer, async () => { calls++; return answer; }, { priorCases: result.results, timeBudget: { requestMs: 40, workflowMs: 500 } });
  assert.equal(resumed.score, 0); assert.equal(calls, 1);
});

test("workflow budget covers multiple requests and retains known completed-request usage", async () => {
  let calls = 0;
  const provider = withRequestTimeBudget({ async invoke(_input, { signal }) {
    calls++; await delay(35, undefined, { signal });
    return { message: { role: "assistant", content: "2" }, finishReason: "stop", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
  } });
  const result = await evaluateTasks([task], scorer, async () => {
    await provider.invoke(input, options()); await provider.invoke(input, options()); await provider.invoke(input, options()); return answer;
  }, { timeBudget: { requestMs: 500, workflowMs: 90 } });
  assert.equal(result.valid, true); assert.equal(result.score, 0); assert.equal(result.results[0]?.timeBudgetOutcome?.scope, "workflow");
  assert.ok(calls >= 2); assert.ok(result.totalTokens >= 7); assert.equal(result.results[0]?.usageKnown, false);
});

test("retry backoff consumes the same workflow budget and preserves the preceding infrastructure fault", async () => {
  let calls = 0;
  const result = await evaluateTasks([task], scorer, async () => { calls++; throw Error("fetch failed"); }, { retryAttempts: 5, timeBudget: { requestMs: 100, workflowMs: 50 } });
  assert.equal(result.valid, false); assert.equal(result.score, 0); assert.equal(calls, 1);
  assert.equal(result.results[0]?.method, "evaluation-error");
  assert.equal(result.results[0]?.error, "fetch failed");
  assert.equal(result.results[0]?.timeBudgetOutcome?.scope, "workflow");
});

test("transport and scorer errors remain invalid; unlimited and quick wrong answers retain normal semantics", async () => {
  const fault = await evaluateTasks([task], scorer, async () => { throw Error("fetch failed"); }, { retryAttempts: 1, timeBudget: unlimited });
  assert.equal(fault.valid, false); assert.equal(fault.results[0]?.method, "evaluation-error");
  const grading = await evaluateTasks([task], { ...scorer, async score() { throw Error("grader unavailable"); } }, async () => answer, { timeBudget: unlimited });
  assert.equal(grading.valid, false); assert.equal(grading.results[0]?.method, "judge-error");
  let calls = 0;
  const wrong = await evaluateTasks([task], { ...scorer, async score() { return { ...await scorer.score(), score: 0 }; } }, async () => { calls++; return answer; }, { retryAttempts: 5, timeBudget: unlimited });
  assert.equal(wrong.valid, true); assert.equal(wrong.score, 0); assert.equal(calls, 1); assert.equal(wrong.timeoutRuns, 0);
});

test("application queue time is excluded from request deadline and cancellation releases the slot", async () => {
  const provider = limitProviderConcurrency(withRequestTimeBudget({ async invoke(_input, { signal }) {
    await delay(70, undefined, { signal }); return { message: { role: "assistant", content: "2" }, finishReason: "stop" };
  } }), 1);
  const results = await Promise.all([1, 2].map(() => withWorkflowTimeBudget({ requestMs: 120, workflowMs: 600 }, () => provider.invoke(input, options()))));
  assert.equal(results.length, 2);
  await assert.rejects(withWorkflowTimeBudget({ requestMs: 20, workflowMs: 300 }, () => provider.invoke(input, options())), TimeBudgetExceeded);
  const next = await withWorkflowTimeBudget({ requestMs: 120, workflowMs: 400 }, () => provider.invoke(input, options()));
  assert.equal(next.message.content, "2");
});

test("real CLI runtime and workflow runner propagate deadline cancellation through Ditto into a valid zero", async () => {
  let calls = 0, canceled = false;
  const settings = { baseUrl: "https://example.invalid", apiKey: "fixture", model: "fixture", concurrency: 1, timeoutMs: 600000 };
  const timeBudget = { requestMs: 50, workflowMs: 500 };
  const runtime = createExperimentRuntime(settings, { timeBudget, provider: { async invoke(_input, { signal }) {
    calls++; signal.addEventListener("abort", () => { canceled = true; }, { once: true });
    await delay(5000, undefined, { signal });
    return { message: { role: "assistant", content: "2" }, finishReason: "stop" };
  } } });
  try {
    const plan = materializeAgentPlan("fixture", [createRootNode(), createInitialSampleNode("Solve")]);
    const runner = createWorkflowRunner(runtime, settings);
    const result = await evaluateTasks([task], scorer, t => runner.run(plan, t), { timeBudget, retryAttempts: 5 });
    assert.equal(result.valid, true); assert.equal(result.score, 0); assert.equal(result.timeoutRuns, 1);
    assert.equal(calls, 1); assert.equal(canceled, true);
  } finally { await runtime.close(); }
});
