import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider, SampleInput } from "@codesoul-co/ditto/worker/infer";
import { normalizeReflectionResponse } from "../ditto/reflection-normalization.js";
import { withReflectionFormatRepair, type ReflectionRepairEvent } from "../ditto/reflection-format.js";
import { GENERATION } from "../protocol.js";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";

const assessment = { passed: false, summary: "A demonstrated arithmetic error." };
const issues = [{ severity: "error", description: "The given sum is incorrect." }];
const answer = "  35 years\n第二行  ";
const input: SampleInput = { model: { model: "fixture", providerOptions: { apiKey: "never-audit-this-provider-secret" } },
  generation: GENERATION, metadata: { nodeType: "INFER.REASONING.REFLECT", taskId: "fixture", nodeId: "revision" },
  messages: [{ role: "system", content: "Preserve the native JSON contract." },
    { role: "user", content: JSON.stringify({ mode: "revise", target: { result: { role: "assistant", content: "old answer" } } }) }] };

test("complete revisedResult strings acquire only the assistant envelope, preserving answer and verdict", () => {
  for (const content of [
    JSON.stringify({ assessment, issues, revisedResult: answer }),
    JSON.stringify({ assessment: { ...assessment, issues, revisedResult: answer } }),
  ]) {
    const normalized = normalizeReflectionResponse(content, "revise");
    const value = JSON.parse(normalized.content);
    assert.deepEqual(value.assessment, assessment);
    assert.deepEqual(value.issues, issues);
    assert.deepEqual(value.revisedResult, { role: "assistant", content: answer });
    assert.ok(normalized.repairs.includes("wrap-string-revisedResult"));
  }
  const native = JSON.stringify({ assessment, issues, revisedResult: { role: "assistant", content: answer } });
  assert.equal(normalizeReflectionResponse(native, "revise").content, native);
});

test("missing/null/empty answers and incomplete message objects cannot be invented from the target", async () => {
  for (const revisedResult of [undefined, null, "", { content: answer }, { role: "assistant" }]) {
    let calls = 0;
    const events: ReflectionRepairEvent[] = [];
    const raw = JSON.stringify({ assessment, issues, ...(revisedResult !== undefined ? { revisedResult } : {}) });
    await assert.rejects(withReflectionFormatRepair({ async invoke() {
      calls++; return { message: { role: "assistant", content: raw }, finishReason: "stop" };
    } }, event => { events.push(event); }).invoke(input, { signal: new AbortController().signal }), /REFLECT_FORMAT_ERROR/);
    assert.equal(calls, 1, "no new assessment or answer may be fabricated by a retry");
    assert.equal(events[0]!.outcome, "exhausted");
    assert.equal(events[0]!.rawContent, raw);
    assert.deepEqual(events[0]!.requestMessages, input.messages.map(({ role, content }) => ({ role, content })));
    assert.equal(events[0]!.finishReason, "stop");
    assert.ok(!JSON.stringify(events).includes("never-audit-this-provider-secret"));
  }
});

test("safe wrapping completes through the public provider adapter without replacing the native request", async () => {
  let calls = 0;
  const events: ReflectionRepairEvent[] = [];
  const raw = JSON.stringify({ assessment, issues, revisedResult: answer });
  const provider: ModelProvider = { async invoke(request) {
    calls++; assert.deepEqual(request.messages, input.messages);
    return { message: { role: "assistant", content: raw }, finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } };
  } };
  const result = await withReflectionFormatRepair(provider, event => { events.push(event); })
    .invoke(input, { signal: new AbortController().signal });
  assert.equal(calls, 1);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
  assert.equal(JSON.parse(String(result.message.content)).revisedResult.content, answer);
  assert.equal(JSON.parse(String(result.message.content)).assessment.passed, false);
  assert.equal((result.message.metadata!.reflectionFormat as { policy: string }).policy, "reflect-format-v3");
  assert.equal(events[0]!.rawContent, raw);
  assert.deepEqual(events[0]!.requestMessages, input.messages.map(({ role, content }) => ({ role, content })));
});

test("unmodified Ditto REFLECT consumes the safe string envelope and adopts the witnessed revision", async () => {
  let calls = 0;
  const experiment = createExperimentRuntime({ baseUrl: "https://example.invalid", model: "fixture", apiKey: "offline", concurrency: 1, timeoutMs: 5000 }, {
    provider: { async invoke(request) {
      calls++;
      const reflecting = String(request.messages[0]?.content).startsWith("Assess the supplied target");
      return { message: { role: "assistant", content: reflecting ? JSON.stringify({ assessment, issues, revisedResult: answer }) : "old answer" },
        finishReason: "stop", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } };
    } },
  });
  try {
    const plan = materializeAgentPlan("search-001", [createRootNode(), createInitialSampleNode(), {
      id: "revise-1", type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [],
      config: { mode: "revise", criteria: ["Correct the demonstrated arithmetic error."], generation: GENERATION },
    }]);
    const result = await new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model).run(plan,
      { id: "fixture", dataset: "math", prompt: "Check the arithmetic.", outputInstruction: "", metadata: {} });
    assert.equal(result.answer, answer);
    assert.equal(calls, 2, "one original answer and one reflection, without a fresh inference retry");
    assert.equal(result.totalTokens, 14);
    assert.equal(result.checkerAudits?.[0]?.decision, "revision-adopted");
  } finally { await experiment.close(); }
});
