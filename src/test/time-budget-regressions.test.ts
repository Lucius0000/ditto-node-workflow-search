import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelProvider, SampleInput } from "@codesoul-co/ditto/worker/infer";
import type { BenchmarkTask } from "../domain.js";
import { evaluateTasks } from "../benchmark/evaluator.js";
import { currentTimeBudgetSignal, withRequestTimeBudget, withWorkflowTimeBudget } from "../execution/time-budget.js";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { PythonTransport } from "../ditto/python-transport.js";
import { createBenchmarkTools, closeBenchmarkTools } from "../ditto/benchmark-tools.js";
import { createTaskMemory } from "../ditto/task-memory.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createBaseline, extendPlan, parseProposal } from "../workflow/capability-schema.js";

const task: BenchmarkTask = { id: "offline", dataset: "gsm8k", prompt: "1+1", outputInstruction: "", metadata: {} };
const usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 };
const sample = { message: { role: "assistant" as const, content: "2" }, finishReason: "stop" as const, usage };
const input: SampleInput = { messages: [{ role: "user", content: "1+1" }], model: { model: "fixture" } };
const options = () => ({ signal: new AbortController().signal });
const scorer = { expectedLabel() { return "2"; }, async score(_id: string, prediction: string) {
  return { score: 1, expected: "2", prediction, normalizedExpected: "2", normalizedPrediction: prediction, method: "fixture" };
} };
const settings = { baseUrl: "https://example.invalid", apiKey: "offline", model: "fixture", concurrency: 1, timeoutMs: 1000 };

test("whole-workflow timeout usage does not add completed retry usage twice", async () => {
  let calls = 0;
  const provider = withRequestTimeBudget({ async invoke() { calls++; return sample; } });
  const result = await evaluateTasks([task], scorer, async () => {
    await provider.invoke(input, options());
    throw Object.assign(new Error("fetch failed"), { ...usage, usageKnown: true, providerAttempts: 1 });
  }, { retryAttempts: 5, timeBudget: { requestMs: 500, workflowMs: 40 } });
  assert.equal(calls, 1);
  assert.equal(result.totalTokens, 7);
  assert.equal(result.providerAttemptCount, 1);
  assert.equal(result.valid, false);
  assert.equal(result.results[0]?.error, "fetch failed");
});

test("an aborted admitted request remains an attempted call with unknown usage", async () => {
  const provider = withRequestTimeBudget({ async invoke(_input, { signal }) { await delay(500, undefined, { signal }); return sample; } });
  const result = await evaluateTasks([task], scorer, async () => { await provider.invoke(input, options()); throw Error("unreachable"); },
    { timeBudget: { requestMs: 30, workflowMs: 500 } });
  assert.equal(result.providerAttemptCount, 1);
  assert.equal(result.unknownUsageAttemptCount, 1);
  assert.equal(result.valid, true);
});

test("completed streamed result usage survives a later workflow timeout", async () => {
  const provider: ModelProvider = withRequestTimeBudget({ async invoke() { return sample; }, async *stream() { yield { type: "result", output: sample }; } });
  const result = await evaluateTasks([task], scorer, async () => {
    for await (const _event of provider.stream!(input, options())) { /* consume final usage */ }
    await delay(200, undefined, { signal: currentTimeBudgetSignal() });
    throw Error("unreachable");
  }, { timeBudget: { requestMs: 500, workflowMs: 40 } });
  assert.equal(result.totalTokens, 7);
  assert.equal(result.providerAttemptCount, 1);
  assert.equal(result.valid, true);
});

test("long and unlimited request policies reach the bridge with an independent 10s connect deadline", async () => {
  const fixture = `const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.cancel!==undefined)return;process.stdout.write(JSON.stringify({id:request.id,status:200,body:{timeoutMs:request.timeoutMs,connectTimeoutMs:request.connectTimeoutMs}})+'\\n');});`;
  const transport = new PythonTransport(settings, { command: process.execPath, arguments: ["--input-type=module", "-e", fixture] });
  try {
    for (const requestMs of [1_200_000, null]) {
      const policy = { requestMs, workflowMs: null, reason: "Offline policy forwarding check" };
      const frame = await withWorkflowTimeBudget(policy, async () => (await transport.fetch(settings.baseUrl, { body: "{}" })).json());
      assert.deepEqual(frame, { timeoutMs: requestMs, connectTimeoutMs: 10_000 });
    }
  } finally { await transport.close(); }
});

test("real Ditto cancellation terminates tools before the next evaluation slot starts", async () => {
  const plan = extendPlan(createBaseline("gsm8k"), parseProposal({ rationale: "Offline cancellation check", node: {
    type: "INTERACTION.ACT.TOOL", graphId: "prepare", dependencies: [],
    config: { tool: "bounded_arithmetic", arguments: { tokens: [{ from: "literal", value: "1+1" }] } },
  } }), "act-cancel-check");
  let live = 0, maximum = 0, closed = 0;
  const result = await evaluateTasks([1, 2, 3].map(id => ({ ...task, id: String(id) })), scorer, async value => {
    const originals = createBenchmarkTools({ testDelayMs: 500 });
    const tools = originals.map(tool => ({ ...tool, async execute(args: Parameters<typeof tool.execute>[0], context: Parameters<typeof tool.execute>[1]) {
      live++; maximum = Math.max(maximum, live);
      try { return await tool.execute(args, context); } finally { live--; }
    } }));
    const runtime = createExperimentRuntime(settings, { tools, memory: createTaskMemory(), provider: { async invoke() { throw Error("provider must not run"); } } });
    try { return await new WorkflowExecutor(runtime.runtime, runtime.providerName, runtime.model).run(plan as unknown as Parameters<WorkflowExecutor["run"]>[0], value, currentTimeBudgetSignal()); }
    finally { try { await runtime.close(); } finally { await closeBenchmarkTools(originals); closed++; } }
  }, { concurrency: 1, timeBudget: { requestMs: 500, workflowMs: 80 } });
  assert.equal(result.timeoutRuns, 3);
  assert.equal(result.valid, true);
  assert.equal(maximum, 1);
  assert.equal(live, 0);
  assert.equal(closed, 3);
});

test("SDK retry progress preserves both HTTP attempts and infrastructure cause on cancellation", async () => {
  const fixture = `const {createInterface}=await import('node:readline');const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.cancel!==undefined)return;const d={requestId:r.id,attempts:1,failedAttempts:1,unknownUsageAttempts:1,usageKnown:false,inputTokens:0,outputTokens:0,totalTokens:0};emit({id:r.id,event:'attempt',status:503,diagnostics:d});emit({id:r.id,event:'attempt',diagnostics:{...d,attempts:2}});});`;
  const transport = new PythonTransport(settings, { command: process.execPath, arguments: ["--input-type=module", "-e", fixture] });
  const provider = withRequestTimeBudget({ async invoke(_input, { signal }) {
    await transport.fetch(settings.baseUrl, { body: "{}", signal });
    return sample;
  } });
  try {
    const result = await evaluateTasks([task], scorer, async () => { await provider.invoke(input, options()); throw Error("unreachable"); },
      { timeBudget: { requestMs: 500, workflowMs: 1000 } });
    assert.equal(result.valid, false);
    assert.match(result.results[0]?.error ?? "", /HTTP 503/);
    assert.equal(result.providerAttemptCount, 2);
    assert.equal(result.unknownUsageAttemptCount, 2);
  } finally { await transport.close(); }
});

test("cancelled queued tool calls never restart a worker after manager close", async () => {
  const tools = createBenchmarkTools({ testDelayMs: 500 });
  const controller = new AbortController();
  const run = () => tools[0]!.execute({ expression: "1+1" }, { signal: controller.signal } as never);
  const first = run(), queued = run();
  const rejected = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(queued, /cancelled/)]);
  await delay(10);
  controller.abort(new Error("fixture cancelled"));
  await closeBenchmarkTools(tools);
  await rejected;
  await assert.rejects(tools[0]!.execute({ expression: "1+1" }, {} as never), /closed/);
});
