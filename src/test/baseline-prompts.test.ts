import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import {
  assertBaselinePromptProfile, baselinePromptProfile, baselinePrompts, baselineTextMessages, MFLOW_PROMPT_SOURCE,
} from "../benchmark/baseline-prompts.js";
import type { BenchmarkTask } from "../domain.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";

// SHA-256 snapshots independently extracted from pinned MFlow src/aflow-seed.ts.
const upstreamPromptHashes = {
  gsm8k: {
    agent: "dc6c7514dd230239e2e8c06d7f082c8fcb69fde9bec31ddd92d8b8c59d8b3d8d",
    review: "35c3125613294785667102d3d54709d971df6534015c29bef1a8d6338e030af6",
    integrate: "a0b5f7bb572dd85c8a04c0f052503c73a74977677c02929f0b952c69362e9972",
  },
  drop: {
    agent: "91d8cc541b6085287f563025ca0b17b2aaba4213e7f51a1bdcafe08548d3d381",
    review: "c2d94d894bf67b54fc205eacaf2f190c4acf867c63df5fee28c2607d5c3cd1e4",
    integrate: "5f356bdda0091ec0a176265e757fc1d7fe9eaad31a562ccfde7a790bb242eece",
  },
};

test("DROP and GSM8K seed prompts match the frozen MFlow source byte for byte", () => {
  for (const dataset of ["drop", "gsm8k"] as const) {
    const prompts = baselinePrompts(dataset)!;
    for (const role of ["agent", "review", "integrate"] as const) {
      assert.equal(createHash("sha256").update(prompts[role]).digest("hex"), upstreamPromptHashes[dataset][role]);
    }
  }
  assert.equal(MFLOW_PROMPT_SOURCE.commit, "9279d7d91bbce039656f5cd3a6bb539cea75fe85");
  assert.equal(baselinePrompts("math"), undefined);
});

const rootSuffixes = {
  gsm8k: "\n\nAssignment: Solve the task and integrate relevant evidence.\nCapability: General task reasoning and evidence integration\nReasoning approach: cot\nExpected output: Complete mathematical solution ending in a boxed final answer.\nStopping criterion: A complete solution or a concrete unresolved obstacle is stated.\n",
  drop: "\n\nAssignment: Answer the supplied reading-comprehension question accurately.\nCapability: Evidence-grounded reading comprehension\nReasoning approach: cot\nExpected output: Answer the question using only the supplied passage and question. Return only the concise final answer; multiple answer spans may be separated with |. Do not include a derivation, Markdown or a boxed answer.\nStopping criterion: A complete answer or a concrete unresolved obstacle is stated.\n",
};

test("root message assembly preserves the public task and MFlow profile without an adapter suffix", () => {
  for (const dataset of ["drop", "gsm8k"] as const) {
    const prompt = "Passage: A paid 7 coins.\nQuestion: How many?\nAnswer:";
    assert.deepEqual(baselineTextMessages(dataset, "INSTRUCTION", prompt), [
      { role: "user", content: "INSTRUCTION\n\n" + prompt + rootSuffixes[dataset] },
    ]);
    assert.deepEqual(baselineTextMessages(dataset, "INSTRUCTION", prompt, { candidate: "7" }), [
      { role: "user", content: "INSTRUCTION\n\n" + prompt + '\n\n{"candidate":"7"}' + rootSuffixes[dataset] },
    ]);
  }
});

for (const dataset of ["drop", "gsm8k"] as const) {
  test(`${dataset} baseline provider request follows the frozen MFlow message contract`, async () => {
    const task: BenchmarkTask & { readonly reference: string } = {
      id: `${dataset}:validate:fixture`, dataset, prompt: "Public problem: what is 3 + 4?",
      outputInstruction: "ADAPTER_SUFFIX_MUST_NOT_REACH_MODEL",
      metadata: { split: "validate", sourceId: "METADATA_MUST_NOT_REACH_MODEL" },
      reference: "GOLD_REFERENCE_MUST_NOT_REACH_MODEL",
    };
    const instruction = baselinePrompts(dataset)!.agent;
    let calls = 0;
    const runtime = createDitto({ workers: [createContextWorker(), createInferWorker({ defaultProvider: "fixture", providers: {
      fixture: { async invoke(input) {
        calls++;
        assert.deepEqual(input.messages, [{ role: "user", content: instruction + "\n\n" + task.prompt + rootSuffixes[dataset] }]);
        assert.doesNotMatch(JSON.stringify(input), /GOLD_REFERENCE_MUST_NOT_REACH_MODEL|ADAPTER_SUFFIX_MUST_NOT_REACH_MODEL|METADATA_MUST_NOT_REACH_MODEL/);
        return { message: { role: "assistant", content: "7" }, finishReason: "stop" };
      } },
    } })] });
    try {
      const plan = materializeAgentPlan("baseline", [createRootNode(), createInitialSampleNode(instruction)]);
      assert.equal((await new WorkflowExecutor(runtime, "fixture", "fixture").run(plan, task)).answer, "7");
      assert.equal(calls, 1);
    } finally { await runtime.close(); }
  });
}

test("missing or changed baseline prompt provenance cannot resume into the new protocol", () => {
  for (const dataset of ["drop", "gsm8k"] as const) {
    const profile = baselinePromptProfile(dataset)!;
    assertBaselinePromptProfile(dataset, JSON.parse(JSON.stringify(profile)));
    assert.throws(() => assertBaselinePromptProfile(dataset, undefined), /pinned MFlow contract/);
    assert.throws(() => assertBaselinePromptProfile(dataset, { ...profile, source: { commit: "other" } }), /pinned MFlow contract/);
  }
  assertBaselinePromptProfile("math", undefined);
});

for (const dataset of ["humaneval", "mbpp"] as const) {
  test(`${dataset} frozen code prompts preserve the MFlow source contract`, () => {
    const prompts = baselinePrompts(dataset)!;
    assert.match(prompts.agent, /Return the complete executable Python solution/);
    assert.deepEqual(Object.fromEntries(Object.entries(prompts).map(([role, text]) => [role, createHash("sha256").update(text).digest("hex")])), {
      agent: "e657d1e085559e4736b6a9de3642905c8fd11c7acbd1652609d7773cadc01a16",
      review: "1d43355b6ee30bc8f5a65bd6d660615282e1fa319aef70fa416e7f4565aa0815",
      integrate: "d5dc5efb7ea76a40ba1777557c4e06d60a462b8e15714bffbb334998ea0c65eb",
    });
    assert.match(prompts.agent, /Task:\nPreserve the requested function name/);
    assert.match(baselineTextMessages(dataset, prompts.agent, "PUBLIC")[0]!.content, /Assignment: Implement the requested Python function correctly\./);
    assertBaselinePromptProfile(dataset, baselinePromptProfile(dataset));
    assert.throws(() => assertBaselinePromptProfile(dataset, undefined), /pinned MFlow contract/);
  });
}
