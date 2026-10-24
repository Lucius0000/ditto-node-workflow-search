import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPlanSpec, BenchmarkTask } from "../domain.js";
import { createBaseline, extendPlan, parseProposal, type CapabilityPlan } from "../workflow/capability-schema.js";
import { parseWorkflowProposal, directedPlan, directedPlanHash } from "../search/directed-proposer.js";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { createWorkflowRunner } from "../workflow/runner.js";
import { materializeAgentPlan, validateNodePath } from "../workflow/spec.js";

const task: BenchmarkTask = { id: "fixture", dataset: "gsm8k", prompt: "12 bags of 8 apples", outputInstruction: "number", metadata: {} };
const settings = { baseUrl: "https://example.invalid", model: "fixture", apiKey: "offline", concurrency: 2, timeoutMs: 600000 };
const source = (nodeId: string, view = "context") => ({ from: "node", nodeId, view });
function add(plan: CapabilityPlan, type: string, id: string, config: object, dependencies: string[] = []) {
  return extendPlan(plan, parseProposal({ rationale: "Exercise public CLI execution path", node: { type, graphId: "prepare", config, dependencies } }), id);
}
function full(plan: CapabilityPlan): AgentPlanSpec {
  const parsed = parseWorkflowProposal(JSON.stringify({ referenceCandidateId: null, rationale: "Use public evidence", nodes: plan.nodes }), "gsm8k");
  return directedPlan("fixture", parsed.nodes, "gsm8k");
}

test("directed CLI parser and public runner execute ACT→OBSERVE→extra LOAD and pass evidence to solver", async () => {
  let plan = add(createBaseline("gsm8k"), "INTERACTION.ACT.TOOL", "find", { tool: "literal_text_find", arguments: { text: { from: "task", field: "prompt" }, needle: { from: "literal", value: "bags" } } });
  plan = add(plan, "INTERACTION.OBSERVE", "observed", { resultSource: source("find", "external-result") }, ["find"]);
  plan = add(plan, "CONTEXT.LOAD", "loaded-result", { sourcesSource: source("observed", "observation") }, ["observed"]);
  const runnable = full(plan);
  validateNodePath(runnable.nodes);
  assert.equal(runnable.nodes.filter(n => n.type === "CONTEXT.LOAD").length, 2);
  const messages: string[] = [];
  const runtime = createExperimentRuntime(settings, { provider: { async invoke(input) {
    messages.push(JSON.stringify(input.messages));
    return { message: { role: "assistant", content: "96" }, finishReason: "stop" };
  } } });
  try {
    const result = await createWorkflowRunner(runtime, settings).run(runnable, task);
    assert.equal(result.answer, "96"); assert.ok(result.executedNodeIds.includes("loaded-result"));
    assert.match(messages[0]!, /loaded-result/); assert.match(messages[0]!, /bags/);
    assert.equal(materializeAgentPlan("fixture", runnable.nodes).outputNodeId, "sample-1");
  } finally { await runtime.close(); }
});

test("public runner registers Memory and isolates writes for concurrent task attempts", async () => {
  let plan = add(createBaseline("gsm8k"), "MEMORY.WRITE", "written", { contentSource: source("context-load") }, ["context-load"]);
  plan = add(plan, "MEMORY.GET", "read-memory", { idsSource: source("written", "memory-ids") }, ["written"]);
  const runnable = full(plan);
  const messages: string[] = [];
  const runtime = createExperimentRuntime(settings, { provider: { async invoke(input) {
    messages.push(JSON.stringify(input.messages)); return { message: { role: "assistant", content: "96" }, finishReason: "stop" };
  } } });
  try {
    const runner = createWorkflowRunner(runtime, settings);
    const results = await Promise.all([runner.run(runnable, task), runner.run(runnable, { ...task, id: "second", prompt: "3 boxes of 7 pears" })]);
    assert.equal(results.length, 2); assert.ok(messages.some(m => m.includes("apples") && !m.includes("pears")));
    assert.ok(messages.some(m => m.includes("pears") && !m.includes("apples")));
  } finally { await runtime.close(); }
});

test("canonical workflow identity normalizes typed source IDs as well as graph dependencies", () => {
  const plan = full(add(createBaseline("gsm8k"), "CONTEXT.SELECT", "selection", { contextSource: source("context-load"), limit: 1 }, ["context-load"]));
  const ids = new Map(plan.nodes.map((n, i) => [n.id, `renamed-${i}`]));
  const renamed = JSON.parse(JSON.stringify(plan), (key, value) => key === "nodeId" && typeof value === "string" ? ids.get(value) ?? value : value) as AgentPlanSpec;
  const nodes = renamed.nodes.map(n => ({ ...n, id: ids.get(n.id)!, dependencies: n.dependencies.map(id => ids.get(id)!) }));
  assert.equal(directedPlanHash(plan), directedPlanHash(directedPlan("renamed", nodes, "gsm8k")));
});

test("new node support still rejects unbound Memory reads, fake observations and private task fields", () => {
  assert.throws(() => add(createBaseline("gsm8k"), "MEMORY.SEARCH", "search", { querySource: { from: "task", field: "prompt" } }), /WRITE/);
  assert.throws(() => add(createBaseline("gsm8k"), "INTERACTION.OBSERVE", "fake", { resultSource: { from: "literal", value: "pretend" } }), /ACT/);
  assert.throws(() => add(createBaseline("gsm8k"), "CONTEXT.UPDATE", "private", { contextSource: source("context-load"), addSource: { from: "task", field: "metadata" } }, ["context-load"]), /task field/);
});
