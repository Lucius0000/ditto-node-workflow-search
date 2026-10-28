import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { createTaskMemory } from "../ditto/task-memory.js";
import { GENERATION } from "../protocol.js";
import { directedPlanHash } from "../search/directed-proposer.js";
import { CapabilityExecutor } from "../workflow/capability-executor.js";
import { observeCapabilityWorkers } from "../workflow/capability-observer.js";
import { capabilityPlan, createBaseline, extendPlan, parseProposal, type CapabilityNode, type CapabilityPlan } from "../workflow/capability-schema.js";

const task = { id: "offline-regression", dataset: "math" as const, prompt: "12 bags with 8 items", outputInstruction: "Return an answer.", metadata: {} };
const source = (nodeId: string, view = "context") => ({ from: "node", nodeId, view });
const proposal = (type: string, config: object, dependencies: string[] = [], graphId = "prepare") => parseProposal({
  rationale: "Exercise a concrete audited regression.", node: { type, config, dependencies, graphId },
});
const solver = (id: string, graphId: "solve" | "refine" = "solve", dependencies: string[] = []): CapabilityNode => ({
  id, type: "INFER.REASONING.SAMPLE", graphId, dependencies,
  config: { role: graphId === "refine" ? "finalizer" : "solver", instruction: "Solve the public task.", generation: GENERATION },
});
async function execute(plan: CapabilityPlan, currentTask = task) {
  const calls: Parameters<ModelProvider["invoke"]>[0][] = [];
  const runtime = createDitto({ workers: observeCapabilityWorkers([
    createContextWorker(), createMemoryWorker(createTaskMemory()), createInferWorker({ defaultProvider: "fixture", providers: { fixture: {
      async invoke(input) {
        calls.push(structuredClone(input));
        return { message: { role: "assistant", content: "ANSWER_SENTINEL" }, finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      },
    } } }),
  ]) });
  try { return { result: await new CapabilityExecutor(runtime, "fixture", "fixture").run(plan, currentTask), calls }; }
  finally { await runtime.close(); }
}

test("binding failure preserves a completed independent sibling, its output and incurred tokens", async () => {
  const base = createBaseline("math");
  const missing = { ...proposal("INTERACTION.ACT.TOOL", { tool: "bounded_arithmetic", arguments: { tokens: [
    { from: "task", field: "prompt", extract: { kind: "decimal-number", index: 999 } },
  ] } }, [], "solve").node, id: "missing-source" };
  const plan = capabilityPlan("parallel-binding-failure", [...base.nodes, missing, solver("final", "refine")]);
  const { result, calls } = await execute(plan);
  assert.equal(calls.length, 1);
  assert.equal(result.candidateFailure?.kind, "binding");
  assert.equal(result.answer, "");
  assert.equal(result.totalTokens, 3);
  assert.ok(result.executedNodeIds.includes("sample-1"));
  assert.equal((result.nodeOutputs["sample-1"] as { message: { content: string } }).message.content, "ANSWER_SENTINEL");
  assert.ok(!result.executedNodeIds.includes("missing-source"));
});

test("completion ledgers stay isolated between simultaneous workflow attempts", async () => {
  const missing = { ...proposal("INTERACTION.ACT.TOOL", { tool: "bounded_arithmetic", arguments: { tokens: [
    { from: "task", field: "prompt", extract: { kind: "decimal-number", index: 999 } },
  ] } }, [], "solve").node, id: "missing-source" };
  const plan = capabilityPlan("parallel-ledger-isolation", [...createBaseline("math").nodes, missing, solver("final", "refine")]);
  const [left, right] = await Promise.all([execute(plan), execute(plan, { ...task, id: "other-task", prompt: "OTHER_TASK_SENTINEL" })]);
  assert.ok(JSON.stringify(left.result.nodeInputs).includes("12 bags"));
  assert.ok(!JSON.stringify(left.result.nodeInputs).includes("OTHER_TASK_SENTINEL"));
  assert.ok(JSON.stringify(right.result.nodeInputs).includes("OTHER_TASK_SENTINEL"));
  assert.ok(left.result.nodeOutputs["sample-1"]); assert.ok(right.result.nodeOutputs["sample-1"]);
  assert.equal(left.result.totalTokens, 3); assert.equal(right.result.totalTokens, 3);
});

test("renamed task LOAD and an extra LOAD named context-load follow their configs", async () => {
  const base = createBaseline("math");
  const nodes: CapabilityNode[] = [
    { ...base.nodes[0]!, id: "task-root" }, base.nodes[1]!,
    { ...proposal("CONTEXT.LOAD", { sourcesSource: source("sample-1", "answer-text") }, [], "refine").node, id: "context-load" },
    solver("final", "refine", ["context-load"]),
  ];
  const { result, calls } = await execute(capabilityPlan("renamed-root", nodes));
  assert.equal(result.answer, "ANSWER_SENTINEL");
  assert.equal(calls.length, 2);
  assert.deepEqual((result.nodeInputs["context-load"] as { sources: unknown }).sources, [{ id: "context-load-source", content: "ANSWER_SENTINEL" }]);
  assert.match(JSON.stringify(calls[1]), /context-load-source/);
});

test("answer ancestry rejects an unused parallel answer before a REFLECT target", () => {
  const selected = extendPlan(createBaseline("math"), proposal("CONTEXT.SELECT", { contextSource: source("context-load"), limit: 1 }, ["context-load"]), "selected");
  const verify: CapabilityNode = { id: "verify", type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [], config: { mode: "verify", criteria: ["Check arithmetic."], generation: GENERATION } };
  assert.throws(() => capabilityPlan("unused-answer", [...selected.nodes, solver("independent"), verify]), /Unused node: sample-1/);
  const merged: CapabilityNode = { id: "merged", type: "INFER.REASONING.DELIBERATE", graphId: "solve", dependencies: ["sample-1", "independent"], config: { mode: "merge", generation: GENERATION } };
  assert.doesNotThrow(() => capabilityPlan("used-answers", [...selected.nodes, solver("independent"), merged, verify]));
});

test("scheduling-only dependencies do not pretend an unused answer is content evidence", () => {
  const base = createBaseline("math");
  const write = { ...proposal("MEMORY.WRITE", { contentSource: { from: "literal", value: "public literal" } }, ["sample-1"], "solve").node, id: "written" };
  assert.throws(() => capabilityPlan("unused-scheduling-answer", [...base.nodes, write, solver("independent", "solve", ["written"])]), /Unused node: sample-1/);
});

test("recorded working-evidence bindings describe actual Infer projection only", async () => {
  const selected = extendPlan(createBaseline("math"), proposal("CONTEXT.SELECT", { contextSource: source("context-load"), limit: 1 }, ["context-load"]), "selected");
  const write = { ...proposal("MEMORY.WRITE", { contentSource: { from: "literal", value: "public literal" } }, ["sample-1"], "solve").node, id: "written" };
  const { result } = await execute(capabilityPlan("real-evidence-bindings", [...selected.nodes, write, solver("final", "refine")]));
  assert.ok(result.evidenceBindings.some(binding => binding.consumerNodeId === "sample-1" && binding.sourceNodeId === "selected"));
  assert.ok(!result.evidenceBindings.some(binding => binding.consumerNodeId === "written"));
});

test("literal Source-looking JSON remains data in workflow identity", () => {
  const make = (value: unknown) => extendPlan(createBaseline("math"), proposal("MEMORY.WRITE", { contentSource: { from: "literal", value } }), "written");
  assert.notEqual(directedPlanHash(make({ from: "node", nodeId: "LITERAL_A" }) as never), directedPlanHash(make({ from: "node", nodeId: "LITERAL_B" }) as never));
  assert.notEqual(directedPlanHash(make([{ from: "literal", value: { from: "node", nodeId: "A" } }]) as never), directedPlanHash(make([{ from: "literal", value: { from: "node", nodeId: "B" } }]) as never));
  const plan = make({ from: "node", nodeId: "context-load" });
  const renamed = capabilityPlan("rename", plan.nodes.map(node => node.id === "context-load" ? { ...node, id: "root-renamed" } : node));
  assert.equal(directedPlanHash(plan as never), directedPlanHash(renamed as never));
});

test("Memory SEARCH bounds match the task-local backend", async () => {
  assert.throws(() => proposal("MEMORY.SEARCH", { querySource: { from: "literal", value: "apple" }, limit: 1001 }), /at most 1000/);
  const written = extendPlan(createBaseline("math"), proposal("MEMORY.WRITE", { contentSource: { from: "literal", value: "apple record" } }), "written");
  const searched = extendPlan(written, proposal("MEMORY.SEARCH", { querySource: { from: "literal", value: "apple" }, limit: 1000 }, ["written"]), "searched");
  const { result } = await execute(searched);
  assert.equal((result.nodeOutputs["searched"] as { records: unknown[] }).records.length, 1);
});

test("latest Memory SEARCH replaces raw writes in active evidence, retaining audit records", async () => {
  const written = extendPlan(createBaseline("math"), proposal("MEMORY.WRITE", { contentSource: { from: "literal", value: ["apple first", "apple second", "EXCLUDED_MEMORY_SENTINEL"] } }), "written");
  const empty = extendPlan(written, proposal("MEMORY.SEARCH", { querySource: { from: "literal", value: "nevermatchingzz" } }, ["written"]), "empty");
  const emptyRun = await execute(empty);
  assert.deepEqual((emptyRun.result.nodeOutputs["empty"] as { records: unknown[] }).records, []);
  assert.match(JSON.stringify(emptyRun.result.nodeOutputs["written"]), /EXCLUDED_MEMORY_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(emptyRun.calls[0]), /EXCLUDED_MEMORY_SENTINEL|apple first|apple second/);
  const limited = extendPlan(written, proposal("MEMORY.SEARCH", { querySource: { from: "literal", value: "apple" }, limit: 1 }, ["written"]), "limited");
  const limitedRun = await execute(limited);
  assert.match(JSON.stringify(limitedRun.calls[0]), /apple first/);
  assert.doesNotMatch(JSON.stringify(limitedRun.calls[0]), /apple second|EXCLUDED_MEMORY_SENTINEL/);
  assert.ok(limitedRun.result.evidenceBindings.some(binding => binding.sourceNodeId === "limited"));
  assert.ok(!limitedRun.result.evidenceBindings.some(binding => binding.consumerNodeId === "sample-1" && binding.sourceNodeId === "written"));
});
