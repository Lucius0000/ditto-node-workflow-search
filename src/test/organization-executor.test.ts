import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import type { BenchmarkTask } from "../domain.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { buildOrganizationPlan, initialOrganization, nodeDefinition } from "../workflow/organization.js";
import { baselinePrompts, baselineTextMessages } from "../benchmark/baseline-prompts.js";
import { executionTopologyHash } from "../search/node-construction.js";
import type { OrganizationSpec } from "../workflow/organization-types.js";

const task: BenchmarkTask = { id: "humaneval:fixture", dataset: "humaneval", prompt: "def answer():\n    \"\"\"Return one.\"\"\"", outputInstruction: "Return Python code.", metadata: {} };
function fixture(invoke: ModelProvider["invoke"]) {
  const runtime = createDitto({ workers: [createContextWorker(), createInferWorker({ defaultProvider: "fixture", providers: { fixture: { invoke } } })] });
  return { executor: new WorkflowExecutor(runtime, "fixture", "fixture"), close: () => runtime.close() };
}
const response = (content: string) => ({ message: { role: "assistant" as const, content }, finishReason: "stop" as const });
function spec(nodes: OrganizationSpec["nodes"], graphs: OrganizationSpec["graphs"], outputNodeId: string): OrganizationSpec {
  return { version: 1, dataset: "humaneval", nodes, graphs, outputNodeId, entryGraphId: graphs[0]!.id,
    transitions: Object.fromEntries(graphs.map((g, i) => [g.id, i + 1 < graphs.length ? { kind: "next", graphId: graphs[i + 1]!.id } : { kind: "end" }])) };
}

test("organization uses real configured Nodes and only explicit cross-Graph dependencies", async () => {
  const seen = new Map<string, string>();
  const f = fixture(async input => { const id = String(input.metadata?.nodeId); seen.set(id, JSON.stringify(input.messages)); return response(id === "secret" ? "UNDECLARED_HISTORY" : id === "first" ? "EXPLICIT_EVIDENCE" : "done"); });
  try {
    const s = spec([{ id: "first", template: "sample", dependencies: [], config: { instruction: "Configured instruction" } }, { id: "secret", template: "sample", dependencies: [] }, { id: "last", template: "sample", dependencies: ["first"] }], [{ id: "start", nodeIds: ["first", "secret"] }, { id: "finish", nodeIds: ["last"] }], "last");
    const result = await f.executor.run(buildOrganizationPlan(s), task);
    assert.equal(result.answer, "done");
    assert.match(seen.get("first")!, /Configured instruction/);
    assert.match(seen.get("last")!, /EXPLICIT_EVIDENCE/);
    assert.doesNotMatch(seen.get("last")!, /UNDECLARED_HISTORY/);
    assert.deepEqual(result.executedGraphIds, ["start", "finish"]);
  } finally { await f.close(); }
});

test("organization checker target is explicit and verify cannot replace it", async () => {
  const f = fixture(async input => {
    const id = String(input.metadata?.nodeId);
    if (id === "check") { assert.match(JSON.stringify(input.messages), /TARGET_CODE/); assert.doesNotMatch(JSON.stringify(input.messages), /OTHER_CODE/); return response(JSON.stringify({ assessment: { passed: false, summary: "error" }, issues: [{ severity: "error", description: "concrete error" }], revisedResult: { role: "assistant", content: "BAD_REPLACEMENT" } })); }
    return response(id === "target" ? "TARGET_CODE" : id === "other" ? "OTHER_CODE" : "done");
  });
  try {
    const s = spec([{ id: "target", template: "sample", dependencies: [] }, { id: "other", template: "sample", dependencies: [] }, { id: "check", template: "verify", dependencies: ["target", "other"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "other", "check"] }], "target");
    const result = await f.executor.run(buildOrganizationPlan(s), task);
    assert.equal(result.answer, "TARGET_CODE");
    assert.equal(result.checkerAudits?.[0]?.targetNodeId, "target");
    assert.equal(result.checkerAudits?.[0]?.finalAnswer, "TARGET_CODE");
    assert.equal(result.checkerAudits?.[0]?.decision, "check-only");
  } finally { await f.close(); }
});

test("organization revise adopts actionable findings for the exact target", async () => {
  const f = fixture(async input => {
    const id = String(input.metadata?.nodeId);
    if (id === "check" || id === "revision") return response(JSON.stringify({ assessment: { passed: false, summary: "wrong literal" }, issues: [{ severity: "error", description: "The answer returns zero instead of one." }], ...(id === "revision" ? { revisedResult: { role: "assistant", content: "def answer(): return 1" } } : {}) }));
    return response("def answer(): return 0");
  });
  try {
    const s = spec([{ id: "target", template: "sample", dependencies: [] }, { id: "check", template: "critique", dependencies: ["target"], targetNodeId: "target" }, { id: "revision", template: "revise", dependencies: ["target", "check"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "check", "revision"] }], "revision");
    const result = await f.executor.run(buildOrganizationPlan(s), task);
    assert.equal(result.answer, "def answer(): return 1");
    assert.deepEqual(result.checkerAudits?.[1]?.feedbackNodeIds, ["check"]);
    assert.equal(result.checkerAudits?.[1]?.decision, "revision-adopted");
  } finally { await f.close(); }
});

test("organization outputByGraph delivers the selected terminating branch", async () => {
  const f = fixture(async input => response(String(input.metadata?.nodeId)));
  try {
    const s = spec([{ id: "first", template: "sample", dependencies: [] }, { id: "selected", template: "sample", dependencies: ["first"] }], [{ id: "start", nodeIds: ["first"] }, { id: "finish", nodeIds: ["selected"] }], "first");
    const result = await f.executor.run(buildOrganizationPlan({ ...s, outputByGraph: { finish: "selected" } }), task);
    assert.equal(result.answer, "selected");
  } finally { await f.close(); }
});

test("organization feedback is optional initially and comes from the previous invocation", async () => {
  let calls = 0;
  const f = fixture(async input => { calls++; const text = JSON.stringify(input.messages); if (calls === 1) assert.doesNotMatch(text, /PREVIOUS_CODE/); else assert.match(text, /PREVIOUS_CODE/); return response(calls === 1 ? "PREVIOUS_CODE" : "DONE"); });
  try {
    const s = spec([{ id: "answer", template: "sample", dependencies: [], feedback: ["answer"] }], [{ id: "solve", nodeIds: ["answer"] }], "answer");
    const result = await f.executor.run(buildOrganizationPlan({ ...s, transitions: { solve: { kind: "repeat", graphId: "solve", maxVisits: 2, until: { sourceNodeId: "answer", path: ["message", "content"], operator: "equals", value: "DONE" } } } }), task);
    assert.equal(result.answer, "DONE");
    assert.deepEqual(result.executedGraphIds, ["solve", "solve"]);
  } finally { await f.close(); }
});

test("organization keeps parallel siblings isolated and sends only public task fields", async () => {
  let calls = 0;
  const f = fixture(async input => {
    calls++;
    const serialized = JSON.stringify(input);
    assert.doesNotMatch(serialized, /canonical_solution|HIDDEN_TEST|private-error|SIBLING_OUTPUT/);
    assert.match(serialized, /Return one/);
    return response("SIBLING_OUTPUT");
  });
  try {
    const s = spec([{ id: "left", template: "sample", dependencies: [] }, { id: "right", template: "sample", dependencies: [] }], [{ id: "solve", nodeIds: ["left", "right"] }], "right");
    const publicTaskWithEvaluatorExtras = { ...task, canonical_solution: "canonical_solution", test: "HIDDEN_TEST", reference: { error: "private-error" } };
    const result = await f.executor.run(buildOrganizationPlan(s), publicTaskWithEvaluatorExtras);
    assert.equal(calls, 2);
    assert.equal(result.answer, "SIBLING_OUTPUT");
    assert.deepEqual(result.loopTrace?.map(({ nodeOutputs: _outputs, ...step }) => step), [{ graphId: "solve", visit: 1, outputNodeId: "right" }]);
    assert.match(JSON.stringify(result.nodeOutputs), /SIBLING_OUTPUT/);
  } finally { await f.close(); }
});

test("organization ignores checker feedback about a different explicit answer", async () => {
  const f = fixture(async input => {
    const id = String(input.metadata?.nodeId);
    if (id === "wrong-check") return response(JSON.stringify({ assessment: { passed: false, summary: "wrong other" }, issues: [{ severity: "error", description: "Wrong other code." }] }));
    if (id === "revision") return response(JSON.stringify({ assessment: { passed: true, summary: "correct" }, issues: [], revisedResult: { role: "assistant", content: "UNJUSTIFIED_REPLACEMENT" } }));
    return response(id === "target" ? "CORRECT_TARGET" : "OTHER_ANSWER");
  });
  try {
    const s = spec([{ id: "target", template: "sample", dependencies: [] }, { id: "other", template: "sample", dependencies: [] }, { id: "wrong-check", template: "verify", dependencies: ["other"], targetNodeId: "other" }, { id: "revision", template: "revise", dependencies: ["target", "wrong-check"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "other", "wrong-check", "revision"] }], "revision");
    const result = await f.executor.run(buildOrganizationPlan(s), task);
    assert.equal(result.answer, "CORRECT_TARGET");
    assert.deepEqual(result.checkerAudits?.[1]?.feedbackNodeIds, []);
  } finally { await f.close(); }
});

test("organization retains normal length budget evidence without falling back to an earlier answer", async () => {
  const { createExperimentRuntime } = await import("../ditto/runtime.js");
  let calls = 0;
  const experiment = createExperimentRuntime({ baseUrl: "https://example.invalid", model: "fixture", apiKey: "fixture", concurrency: 1, timeoutMs: 5000 }, { provider: { async invoke(input) {
    calls++;
    return input.metadata?.nodeId === "revision"
      ? { ...response("{partial"), finishReason: "length", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      : { ...response("EARLIER_CORRECT_CODE"), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
  } } });
  try {
    const s = spec([{ id: "target", template: "sample", dependencies: [] }, { id: "revision", template: "revise", dependencies: ["target"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "revision"] }], "revision");
    const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
    const result = await executor.run(buildOrganizationPlan(s), task);
    assert.equal(result.answer, "");
    assert.equal(result.generationOutcomes?.[0]?.usable, false);
    assert.equal(result.generationOutcomes?.[0]?.content, "{partial");
    assert.equal(result.totalTokens, 6);
    assert.equal(calls, 2);
  } finally { await experiment.close(); }
});

for (const dataset of ["humaneval", "mbpp"] as const) {
  test(`${dataset} Provider messages depend on effective SAMPLE inputs, not unrelated graph edits, IDs or default spelling`, async () => {
    const seen: unknown[] = [];
    const f = fixture(async input => {
      if (input.metadata?.nodeType === "INFER.REASONING.SAMPLE") seen.push(structuredClone(input.messages));
      return response(input.metadata?.nodeType === "INFER.REASONING.REFLECT"
        ? JSON.stringify({ assessment: { passed: true, summary: "ok" }, issues: [] }) : "def answer(): return 1");
    });
    try {
      const base = initialOrganization(dataset);
      const withVerify: OrganizationSpec = { ...base,
        nodes: [...base.nodes, { id: "check", template: "verify", dependencies: ["sample-1"], targetNodeId: "sample-1" }],
        graphs: [{ id: "solve", nodeIds: ["context", "sample-1", "check"] }] };
      const explicit = { ...base, nodes: base.nodes.map(n => ({ ...n, config: nodeDefinition(dataset, n, "solve").config })) };
      assert.equal(executionTopologyHash(base), executionTopologyHash(explicit));
      const renamed: OrganizationSpec = { ...explicit, nodes: explicit.nodes.map(n => ({ ...n,
        id: n.id === "context" ? "loaded" : "answer", dependencies: n.dependencies.map(() => "loaded") })),
        graphs: [{ id: "renamed", nodeIds: ["loaded", "answer"] }], entryGraphId: "renamed", transitions: { renamed: { kind: "end" } }, outputNodeId: "answer" };
      const unrelated: OrganizationSpec = { ...base, nodes: [...base.nodes, { id: "unused", template: "sample", dependencies: [] }],
        graphs: [{ id: "solve", nodeIds: ["context", "sample-1", "unused"] }] };
      for (const org of [base, withVerify, explicit, renamed]) await f.executor.run(buildOrganizationPlan(org), { ...task, dataset });
      assert.equal(seen.length, 4);
      const expected = baselineTextMessages(dataset, baselinePrompts(dataset)!.agent, task.prompt);
      for (const messages of seen) assert.deepEqual(messages, expected);
      seen.length = 0;
      await f.executor.run(buildOrganizationPlan(unrelated), { ...task, dataset });
      assert.deepEqual(seen[0], expected);
      assert.deepEqual(seen[1], expected);
    } finally { await f.close(); }
  });
}

test("SAMPLE includes real bound answers and context metadata, with rename-invariant evidence labels", async () => {
  const seen = new Map<string, unknown>();
  const f = fixture(async input => { seen.set(String(input.metadata?.nodeId), structuredClone(input.messages)); return response(input.metadata?.nodeId === "first" || input.metadata?.nodeId === "renamed-first" ? "WIRED_ANSWER" : "done"); });
  try {
    const s = spec([{ id: "context", template: "context", dependencies: [], config: { includeTaskMetadata: true } },
      { id: "first", template: "sample", dependencies: [] }, { id: "last", template: "sample", dependencies: ["context", "first"], config: { instruction: "EDITED_INSTRUCTION" } }],
      [{ id: "solve", nodeIds: ["context", "first", "last"] }], "last");
    await f.executor.run(buildOrganizationPlan(s), { ...task, metadata: { publicClue: "METADATA_EVIDENCE" } });
    const original = seen.get("last");
    assert.match(JSON.stringify(original), /EDITED_INSTRUCTION|WIRED_ANSWER|METADATA_EVIDENCE/);
    for (const token of ["EDITED_INSTRUCTION", "WIRED_ANSWER", "METADATA_EVIDENCE"]) assert.match(JSON.stringify(original), new RegExp(token));
    const rename = (id: string) => `renamed-${id}`;
    const renamed: OrganizationSpec = { ...s, nodes: s.nodes.map(n => ({ ...n, id: rename(n.id), dependencies: n.dependencies.map(rename) })),
      graphs: s.graphs.map(g => ({ ...g, nodeIds: g.nodeIds.map(rename) })), outputNodeId: rename(s.outputNodeId) };
    await f.executor.run(buildOrganizationPlan(renamed), { ...task, metadata: { publicClue: "METADATA_EVIDENCE" } });
    assert.deepEqual(seen.get("renamed-last"), original);
    const rewired = { ...s, nodes: s.nodes.map(n => n.id === "last" ? { ...n, dependencies: ["context"] } : n) };
    await f.executor.run(buildOrganizationPlan(rewired), { ...task, metadata: { publicClue: "METADATA_EVIDENCE" } });
    assert.doesNotMatch(JSON.stringify(seen.get("last")), /WIRED_ANSWER/);
    assert.notDeepEqual(seen.get("last"), original);
  } finally { await f.close(); }
});

test("configured TRAJECTORY maxSteps bounds actual Provider calls without changing fixed generation", async () => {
  const { createExperimentRuntime } = await import("../ditto/runtime.js");
  const { GENERATION } = await import("../protocol.js");
  for (const maxSteps of [1, 2, 3]) {
    let calls = 0;
    const experiment = createExperimentRuntime({ baseUrl: "https://example.invalid", model: "fixture", apiKey: "fixture", concurrency: 1, timeoutMs: 5000 }, { provider: { async invoke(input) {
      calls++;
      assert.equal(input.generation?.temperature, GENERATION.temperature);
      assert.equal(input.generation?.maxTokens, GENERATION.maxTokens);
      return response("def answer(): return 1");
    } } });
    try {
      const s = spec([{ id: "reason", template: "cot", dependencies: [], config: { strategy: "long-cot", options: { rounds: 3 }, maxSteps } }], [{ id: "solve", nodeIds: ["reason"] }], "reason");
      const result = await new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model).run(buildOrganizationPlan(s), task);
      assert.equal(calls, maxSteps);
      assert.equal(result.answer, "def answer(): return 1");
      assert.equal((result.nodeOutputs?.reason as any)?.stopReason, maxSteps < 3 ? "max_steps" : "completed");
    } finally { await experiment.close(); }
  }
  for (const maxSteps of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const s = spec([{ id: "reason", template: "cot", dependencies: [], config: { maxSteps } }], [{ id: "solve", nodeIds: ["reason"] }], "reason");
    assert.throws(() => buildOrganizationPlan(s), /maxSteps/);
  }
});


test("code revise first Provider request states the required full message without changing check-only modes or accepting omissions", async () => {
  const { CODE_REVISE_OUTPUT_CONTRACT } = await import("../workflow/checker-policy.js");
  const { createExperimentRuntime } = await import("../ditto/runtime.js");
  for (const dataset of ["humaneval", "mbpp"] as const) {
    for (const mode of ["verify", "critique", "revise"] as const) {
      const f = fixture(async input => {
        if (input.metadata?.nodeId === "checker") {
          const body = JSON.parse(String(input.messages.at(-1)!.content));
          const descriptions = body.criteria.map((c: { description: string }) => c.description);
          assert.equal(descriptions.includes(CODE_REVISE_OUTPUT_CONTRACT), mode === "revise");
          assert.equal(body.target.result.content, "ORIGINAL_CODE");
          return response(JSON.stringify({ assessment: { passed: true, summary: "correct" }, issues: [],
            ...(mode === "revise" ? { revisedResult: { role: "assistant", content: "ORIGINAL_CODE" } } : {}) }));
        }
        return response("ORIGINAL_CODE");
      });
      try {
        const s = { ...spec([{ id: "target", template: "sample", dependencies: [] }, { id: "checker", template: mode, dependencies: ["target"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "checker"] }], mode === "revise" ? "checker" : "target"), dataset };
        const result = await f.executor.run(buildOrganizationPlan(s), { ...task, dataset });
        assert.equal(result.answer, "ORIGINAL_CODE");
        assert.equal(result.checkerAudits?.[0]?.decision, mode === "revise" ? "preserved-passed-or-no-error" : "check-only");
      } finally { await f.close(); }
    }
    const experiment = createExperimentRuntime({ baseUrl: "https://example.invalid", model: "fixture", apiKey: "fixture", concurrency: 1, timeoutMs: 5000 }, { provider: { async invoke(input) {
      return input.metadata?.nodeId === "checker"
        ? response(JSON.stringify({ assessment: { passed: true, summary: "ok" }, issues: [] })) : response("ORIGINAL_CODE");
    } } });
    try {
      const s = { ...spec([{ id: "target", template: "sample", dependencies: [] }, { id: "checker", template: "revise", dependencies: ["target"], targetNodeId: "target" }], [{ id: "solve", nodeIds: ["target", "checker"] }], "checker"), dataset };
      await assert.rejects(new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model).run(buildOrganizationPlan(s), { ...task, dataset }), /REFLECT_FORMAT_ERROR/);
    } finally { await experiment.close(); }
  }
});
